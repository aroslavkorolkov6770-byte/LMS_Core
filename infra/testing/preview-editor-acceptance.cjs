const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const clientId = process.env.CORE_PREVIEW_CLIENT_ID || "ffe5afda-f49c-4518-9dea-429dca1dbf1e";
const label = process.env.CORE_PREVIEW_ACCEPTANCE_LABEL || "before-live-draft";
const output = path.join(root, "infra/runtime/local-acceptance/preview-20261029", randomUUID());

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [], mutations = [], navigations = [], hydrationErrors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && /hydrat|server rendered|didn't match/i.test(message.text())) hydrationErrors.push(message.text().split("\n")[0]); });
    page.on("framenavigated", (frame) => { if (frame.parentFrame() === page.mainFrame() && frame.url().includes("previewClientId=")) navigations.push(frame.url().split("?")[0]); });
    await context.route(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\//, (route) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) { mutations.push({ method: route.request().method(), path: new URL(route.request().url()).pathname }); return route.abort(); }
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:3100/preview?clientId=${encodeURIComponent(clientId)}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    const frame = page.frameLocator(".runtime-frame");
    await frame.locator('[data-preview-editable="home.title"]').waitFor({ timeout: 90000 });
    await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor({ timeout: 30000 });
    const originalTitle = await frame.locator('[data-preview-editable="home.title"]').innerText();
    const startNavigations = navigations.length;
    const titleInput = page.locator(".field").filter({ has: page.locator("label", { hasText: /^Главный заголовок$/ }) }).locator("input");
    const titleChanges = [];
    for (const title of ["Локальная проверка A", "Локальная проверка B"]) {
      const started = Date.now();
      await titleInput.fill(title);
      await frame.locator('[data-preview-editable="home.title"]').filter({ hasText: title }).waitFor({ timeout: 30000 });
      titleChanges.push(Date.now() - started);
    }
    await page.locator(".inspector-tabs").getByRole("button", { name: "Цвета", exact: true }).click();
    const primaryInput = page.locator(".field").filter({ has: page.locator("label", { hasText: /^Основной цвет$/ }) }).locator('input[type="color"]');
    const started = Date.now();
    await primaryInput.evaluate((input) => { input.value = "#3478c2"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await frame.locator('[data-preview-editable="home.badge"]').evaluate((element) => element.setAttribute("data-acceptance-before-color", "1"));
    await page.waitForFunction(() => {
      const document = window.document.querySelector(".runtime-frame")?.contentDocument;
      return document?.documentElement?.style.getPropertyValue("--lms-theme-primary") === "#3478c2";
    }, null, { timeout: 30000 });
    const colorLatencyMs = Date.now() - started;
    const extraFrameNavigations = navigations.length - startNavigations;
    const stateChecks = {};
    if (label.startsWith("after-")) {
      const marker = randomUUID();
      await frame.locator("body").evaluate((_body, marker) => { window.__corePreviewDocument = marker; window.scrollTo(0, 120); }, marker);
      const scrollBefore = await frame.locator("body").evaluate(() => window.scrollY);
      assert.ok(scrollBefore > 0, "Scroll retention must exercise a genuinely scrolled page");
      await primaryInput.evaluate((input) => { input.value = "#426d34"; input.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.waitForFunction(() => document.querySelector(".runtime-frame")?.contentDocument?.documentElement?.style.getPropertyValue("--lms-theme-primary") === "#426d34");
      assert.equal(await frame.locator("body").evaluate(() => window.scrollY), scrollBefore);
      assert.equal(await frame.locator("body").evaluate(() => window.__corePreviewDocument), marker);
      stateChecks.scrolledDocumentRetained = true;
      const burstNavigations = navigations.length;
      const burstStarted = Date.now();
      await primaryInput.evaluate((input) => {
        for (let index = 0; index < 50; index++) {
          input.value = `#${(0x208000 + index * 101).toString(16).padStart(6, "0")}`;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      const burstFinal = `#${(0x208000 + 49 * 101).toString(16)}`;
      await page.waitForFunction((color) => document.querySelector(".runtime-frame")?.contentDocument?.documentElement?.style.getPropertyValue("--lms-theme-primary") === color, burstFinal);
      assert.equal(await frame.locator("body").evaluate(() => window.__corePreviewDocument), marker);
      assert.equal(navigations.length, burstNavigations);
      stateChecks.colorBurst50Ms = Date.now() - burstStarted;
      await page.locator(".inspector-tabs").getByRole("button", { name: "Текст", exact: true }).click();
      const subtitleInput = page.locator(".field").filter({ has: page.locator("label", { hasText: /^Подзаголовок$/ }) }).locator("textarea");
      const savedSubtitle = await subtitleInput.inputValue();
      const longSubtitle = "Длинный несохраненный текст ".repeat(640);
      await subtitleInput.fill(longSubtitle);
      await page.waitForFunction((text) => document.querySelector(".runtime-frame")?.contentDocument?.querySelector('[data-preview-editable="home.subtitle"]')?.textContent === text, longSubtitle);
      const frameSource = await page.locator(".runtime-frame").getAttribute("src");
      assert.ok(frameSource.length < 1500, "Large drafts must not be serialized into the iframe URL");
      assert.ok(!frameSource.includes("previewHomeSubtitle"));
      assert.equal(await frame.locator("body").evaluate(() => window.__corePreviewDocument), marker);
      stateChecks.longDraftUsesShortUrl = { textCharacters: longSubtitle.length, frameUrlCharacters: frameSource.length };
      await subtitleInput.fill(savedSubtitle);
      await page.locator(".inspector-tabs").getByRole("button", { name: "Шрифты", exact: true }).click();
      await page.locator(".field").filter({ has: page.locator("label", { hasText: /^Шрифт заголовков$/ }) }).locator("select").selectOption("Georgia");
      await page.waitForFunction(() => document.querySelector(".runtime-frame")?.contentDocument?.querySelector('[data-preview-editable="home.title"]')?.style.fontFamily.includes("Georgia"));
      stateChecks.liveFont = true;
      await page.getByRole("button", { name: "Выбор включен", exact: true }).click();
      await frame.locator('body[data-preview-select-mode="0"]').waitFor();
      await frame.locator(".guest-header > div").click();
      const modal = frame.locator(".auth-modal");
      await modal.getByPlaceholder("Логин", { exact: true }).fill("acceptance_unsaved_login");
      await modal.getByPlaceholder("Пароль", { exact: true }).fill("fixture-not-a-real-password");
      await page.locator(".inspector-tabs").getByRole("button", { name: "Цвета", exact: true }).click();
      await primaryInput.evaluate((input) => { input.value = "#98642b"; input.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.waitForFunction(() => document.querySelector(".runtime-frame")?.contentDocument?.documentElement?.style.getPropertyValue("--lms-theme-primary") === "#98642b");
      assert.equal(await modal.getByPlaceholder("Логин", { exact: true }).inputValue(), "acceptance_unsaved_login");
      assert.equal(await modal.getByPlaceholder("Пароль", { exact: true }).inputValue(), "fixture-not-a-real-password");
      assert.equal(await frame.locator("body").evaluate(() => window.__corePreviewDocument), marker);
      stateChecks.openLoginModalRetained = true;
      const ordinary = await context.newPage();
      await ordinary.goto(`http://127.0.0.1:3100/client/${encodeURIComponent(clientId)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      const savedFrame = ordinary.frameLocator(".client-site-frame");
      await savedFrame.locator('[data-preview-editable="home.title"]').waitFor();
      await ordinary.locator(".client-site-cover").waitFor({ state: "hidden" });
      assert.equal((await savedFrame.locator('[data-preview-editable="home.title"]').innerText()).trim(), originalTitle.trim());
      assert.equal(await savedFrame.locator("#lms-preview-runtime-bridge-style").count(), 0);
      assert.equal(await savedFrame.locator("body").getAttribute("data-preview-select-mode"), null);
      stateChecks.standaloneSavedViewIsolated = true;
      await ordinary.close();
      await page.locator(".screen-rail").getByRole("button", { name: "Вход", exact: true }).click();
      await frame.locator('[data-preview-editable="login.card"]').waitFor();
      await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor();
      await frame.getByPlaceholder("Логин", { exact: true }).fill("kept_on_login_page");
      await frame.getByPlaceholder("Пароль", { exact: true }).fill("fixture-not-a-real-password");
      const loginNavigations = navigations.length;
      await primaryInput.evaluate((input) => { input.value = "#7534a1"; input.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.waitForFunction(() => document.querySelector(".runtime-frame")?.contentDocument?.documentElement?.style.getPropertyValue("--lms-theme-primary") === "#7534a1");
      assert.equal(await frame.getByPlaceholder("Логин", { exact: true }).inputValue(), "kept_on_login_page");
      assert.equal(await frame.getByPlaceholder("Пароль", { exact: true }).inputValue(), "fixture-not-a-real-password");
      assert.equal(navigations.length, loginNavigations);
      stateChecks.loginPageInputsRetained = true;
      await page.locator(".top-actions").getByRole("button", { name: "Главная", exact: true }).click();
      await frame.locator('[data-preview-editable="home.title"]').waitFor();
      await page.locator(".inspector-tabs").getByRole("button", { name: "Кнопки", exact: true }).click();
      await page.getByRole("checkbox", { name: "Показывать CTA-кнопку на главной", exact: true }).check();
      await frame.locator('[data-preview-editable="home.cta"] a').waitFor();
      await frame.locator('[data-preview-editable="home.cta"] a').click();
      await frame.locator('[data-preview-editable="tasks.dashboardTitle"]').waitFor({ timeout: 60000 });
      await page.locator(".top-actions").getByRole("button", { name: "Главная", exact: true }).click();
      await frame.locator('[data-preview-editable="home.title"]').waitFor();
      await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor();
      stateChecks.homeReturnsAfterInternalNavigation = true;
      assert.equal(await page.getByRole("heading", { name: "Авторизация и сессия", exact: true }).count(), 0);
      assert.equal(await page.locator("footer").count(), 0);
      stateChecks.noLmsCookieBannerOrFooterOverEditor = true;
    }
    const result = { checkedAt: new Date().toISOString(), label, realNextUi: true, clientId, titleChangesMs: titleChanges, colorLatencyMs, extraFrameNavigations, stateChecks, blockedMutations: mutations, errors, hydrationErrors };
    if (label.startsWith("after-")) assert.equal(result.extraFrameNavigations, 0, "Editing text/color must not navigate the LMS iframe");
    assert.deepEqual(mutations, [], "This acceptance is read-only, not a settings save");
    if (label.startsWith("after-")) assert.deepEqual(errors, []);
    if (label.startsWith("after-")) assert.deepEqual(hydrationErrors, []);
    await page.screenshot({ path: path.join(output, "editor.png"), caret: "initial" });
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, output }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
