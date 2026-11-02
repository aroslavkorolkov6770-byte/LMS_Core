"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

// Assert source UI in a real browser, not merely the presence of a successful HTTP response.
async function assertSourceUi(page, origin, output) {
  await fs.mkdir(output, { recursive: true });
  await page.goto(origin + "/login");
  await page.getByRole("heading", { name: "Вход в Ватэс", exact: true }).waitFor();
  const consent = page.getByRole("button", { name: "Только на сеанс", exact: true });
  try { await consent.waitFor({ state: "visible", timeout: 2500 }); await consent.click(); } catch { /* A retained test session may already have a consent choice. */ }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const states = [];
  for (const width of [1440, 393]) {
    await page.setViewportSize({ width, height: width === 1440 ? 950 : 852 });
    for (const theme of ["light", "dark"]) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) {
        await page.getByRole("button", { name: theme === "dark" ? "Включить темную тему" : "Включить светлую тему", exact: true }).click();
      }
      // Original controls animate for 200 ms; sample their final style, not the transition's first frame.
      await page.waitForTimeout(350);
      const metrics = await page.evaluate(() => {
        const button = document.querySelector(".login-box > button.hover-unified-auth"), css = getComputedStyle(button), rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const logos = [...document.querySelectorAll('img[alt="Ватэс"]')].map((img) => ({ width: img.naturalWidth, loaded: img.complete, visible: img.getBoundingClientRect().width > 0 && img.getBoundingClientRect().height > 0 }));
        return { theme: document.documentElement.dataset.theme, background: getComputedStyle(document.documentElement).getPropertyValue("--app-background").trim(), bodyFont: getComputedStyle(document.body).fontFamily,
          radius: css.borderRadius, buttonColor: css.backgroundColor, buttonText: css.color, hit: hit === button || button.contains(hit),
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth, logos, coreStyles: document.querySelectorAll("style[data-core-design-style],.core-client-brand").length, coreRoot: document.documentElement.hasAttribute("data-core-design") };
      });
      assert.equal(metrics.theme, theme);
      assert.equal(metrics.background, theme === "light" ? "#f5f7fa" : "#111820");
      assert.equal(metrics.radius, "11px"); assert.ok(metrics.bodyFont.includes("Segoe UI"));
      assert.equal(metrics.buttonText, "rgb(255, 255, 255)");
      assert.equal(metrics.buttonColor, theme === "light" ? "rgb(46, 125, 120)" : "rgb(86, 184, 176)");
      assert.equal(metrics.hit, true, "The primary action must not be covered or outside the viewport");
      assert.ok(metrics.scrollWidth <= metrics.width + 1, "No horizontal overflow");
      assert.ok(metrics.logos.some((logo) => logo.visible && logo.loaded && logo.width > 0), "An actual source PNG logo must be visible and loaded");
      assert.equal(metrics.coreStyles, 0); assert.equal(metrics.coreRoot, false);
      const document = await cdp.send("DOM.getDocument"), node = await cdp.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: ".login-card-heading h1" });
      metrics.renderedFonts = (await cdp.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId })).fonts.map((font) => font.familyName);
      assert.ok(metrics.renderedFonts.length > 0 && !metrics.renderedFonts.includes("Times New Roman"));
      await page.screenshot({ path: path.join(output, `${width}-${theme}.png`), animations: "disabled" });
      states.push(metrics);
    }
  }
  await page.getByText("Пройти регистрацию", { exact: true }).click();
  await page.getByRole("heading", { name: "Активация аккаунта", exact: true }).waitFor();
  await page.getByPlaceholder("Ваше Имя (для профиля)", { exact: true }).waitFor();
  await page.getByText("Войти", { exact: true }).click();
  await page.getByRole("heading", { name: "Вход в Ватэс", exact: true }).waitFor();
  return { states, registrationRoundTrip: true };
}

module.exports = { assertSourceUi };
