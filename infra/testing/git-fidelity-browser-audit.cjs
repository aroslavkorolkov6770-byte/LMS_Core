"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

// Read-only diagnosis: own browser context, anonymous session, no submissions or database writes.
async function audit(origin, output) {
  const parsed = new URL(origin);
  assert.equal(parsed.hostname, "127.0.0.1"); assert.equal(parsed.protocol, "http:"); assert.ok(parsed.port);
  const health = await fetch(`${origin}/api/core-runtime/health`, { signal: AbortSignal.timeout(4000) });
  const identity = await health.json(); assert.equal(identity.protocol, "lms-core-client-v1");
  assert.equal(identity.storage, "postgresql-runtime");
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
    const rejected = [], mocked = [], errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("vates_theme_v1", "light"));
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) { rejected.push({ method: request.method(), path: url.pathname }); return route.abort(); }
      if (url.pathname === "/api/auth/session") { mocked.push(url.pathname); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false, user: null }) }); }
      if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/core-runtime/")) { mocked.push(url.pathname); return route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); }
      return route.continue();
    });
    await page.goto(origin + "/login");
    await page.locator(".login-box input[type=password]").waitFor();
    await page.locator("style[data-core-design-style]").waitFor({ state: "attached" });
    const onlySession = page.getByRole("button", { name: "Только на сеанс", exact: true });
    if (await onlySession.isVisible()) await onlySession.click();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const measure = async (label) => {
      // Source buttons have 200 ms transitions; measuring the first frame would record the old radius/color.
      await page.waitForTimeout(350);
      const result = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector); if (!node) return null;
          const style = getComputedStyle(node), rect = node.getBoundingClientRect();
          const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { text: node.textContent.trim().slice(0, 100), fontFamily: style.fontFamily, background: style.backgroundColor, color: style.color, fontSize: style.fontSize, radius: style.borderRadius, width: Math.round(rect.width), height: Math.round(rect.height), centerHit: !!top && (node === top || node.contains(top)) };
        };
        return { theme: document.documentElement.dataset.theme, coreDesign: document.documentElement.hasAttribute("data-core-design"), backgroundVariable: getComputedStyle(document.documentElement).getPropertyValue("--app-background").trim(), sourceLogoImages: document.querySelectorAll('img[src*="vates-logo-transparent"],img[srcset*="vates-logo-transparent"]').length, replacementBrandSpans: document.querySelectorAll(".core-client-brand").length, fontCheckInter: document.fonts.check('16px "Inter"'), body: read("body"), heading: read(".vates-auth-message h1"), primary: read(".login-box > button.hover-unified-auth"), input: read(".login-input"), card: read(".login-box") };
      });
      const document = await cdp.send("DOM.getDocument");
      const node = await cdp.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: ".vates-auth-message h1" });
      result.renderedHeadingFonts = (await cdp.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId })).fonts.map(({ familyName, isCustomFont, glyphCount }) => ({ familyName, isCustomFont, glyphCount }));
      await page.screenshot({ path: path.join(output, `${label}.png`), animations: "disabled" });
      return { label, ...result };
    };
    const enabledLight = await measure("core-light");
    await page.getByRole("button", { name: "Включить темную тему", exact: true }).click();
    const enabledDark = await measure("core-dark");
    await page.getByRole("button", { name: "Включить светлую тему", exact: true }).click();
    // This is NOT a pristine Git screenshot: text/logo replacements remain. Only isolate CSS in this private tab.
    await page.evaluate(() => { document.querySelector("style[data-core-design-style]").media = "not all"; document.documentElement.removeAttribute("data-core-design"); });
    const disabledLight = await measure("core-css-disabled-light");
    await page.getByRole("button", { name: "Включить темную тему", exact: true }).click();
    const disabledDark = await measure("core-css-disabled-dark");
    await page.getByText("Пройти регистрацию", { exact: true }).click();
    await page.getByPlaceholder("Ваше Имя (для профиля)", { exact: true }).waitFor();
    const registrationNavigation = true;
    const receipt = { checkedAt: new Date().toISOString(), identity, states: [enabledLight, enabledDark, disabledLight, disabledDark], registrationNavigation, errors, mocked, rejected, databaseWrites: 0, sourceChanges: false, activeAppSessionChanged: false, limit: "Anonymous login/registration and CSS isolation only; not a complete functional audit or pristine Git rendering." };
    await fs.writeFile(path.join(output, "browser-css-audit.json"), JSON.stringify(receipt, null, 2));
    assert.equal(enabledLight.sourceLogoImages, 0); assert.ok(enabledLight.replacementBrandSpans > 0);
    assert.equal(enabledLight.backgroundVariable, enabledDark.backgroundVariable, "Core layer prevents normal theme background switching");
    assert.notEqual(disabledLight.backgroundVariable, disabledDark.backgroundVariable, "Original theme CSS responds when Core layer is disabled");
    assert.notEqual(enabledLight.primary.radius, disabledLight.primary.radius);
    assert.notEqual(enabledLight.body.fontFamily, disabledLight.body.fontFamily);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ output, states: receipt.states.map(({ label, theme, backgroundVariable, renderedHeadingFonts, primary, body }) => ({ label, theme, backgroundVariable, renderedHeadingFonts, radius: primary.radius, buttonBackground: primary.background, buttonText: primary.color, font: body.fontFamily })), registrationNavigation, errors, databaseWrites: 0 }));
  } finally { await browser.close(); }
}

audit(process.argv[2], process.argv[3]).catch((error) => { console.error(error.message); process.exitCode = 1; });
