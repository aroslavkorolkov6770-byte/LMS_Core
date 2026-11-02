const { _electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const appDirectory = path.join(root, "apps/control-center");
const output = path.join(root, "infra/runtime/local-acceptance/interface-20261029", randomUUID());
const profile = path.join(output, "profile");
const ownerPreferenceFile = path.join(process.env.APPDATA, "@lms-core/control-center/interface-preferences.json");
const env = { ...process.env };
env.CORE_TEST_NATIVE_PROFILE = profile;
delete env.ELECTRON_RUN_AS_NODE;
let application;
let original;
const errors = [];

async function launch() {
  application = await _electron.launch({
    executablePath: path.join(appDirectory, "node_modules/electron/dist/electron.exe"),
    args: [path.join(__dirname, "native-frame-entry.cjs")], cwd: appDirectory, env, timeout: 30000
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.waitForFunction(() => document.body.dataset.launcherReady === "true", null, { timeout: 60000 });
  return page;
}

function contrast(first, second) {
  const luminance = (hex) => {
    const rgb = hex.trim().replace("#", "").match(/../g).map((value) => parseInt(value, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function saveFinished(page) { await page.evaluate(() => preferencesWriteQueue); }
async function noHorizontalOverflow(page, selector) {
  const result = await page.locator(selector).evaluate((element) => ({ scroll: element.scrollWidth, width: element.clientWidth }));
  assert.ok(result.scroll <= result.width + 1, `${selector} horizontal overflow: ${JSON.stringify(result)}`);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(profile);
  const originalOwnerPreferences = await fs.readFile(ownerPreferenceFile);
  await fs.writeFile(path.join(profile, "interface-preferences.json"), originalOwnerPreferences);
  try {
    let page = await launch();
    original = await page.evaluate(() => getCurrentPreferences());
    assert.equal(await page.locator("#execution-mode-select").inputValue(), "local");
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    const palettes = ["midnight", "graphite", "ocean", "forest", "ember", "sand", "porcelain", "mist"];
    const ratios = {};
    for (const theme of palettes) {
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      await saveFinished(page);
      assert.equal(await page.locator("body").getAttribute("data-theme"), theme);
      const colors = await page.evaluate(() => {
        const css = getComputedStyle(document.body);
        return Object.fromEntries(["text", "muted", "surface", "bg", "accent-strong", "on-accent"].map((key) => [key, css.getPropertyValue(`--${key}`).trim()]));
      });
      ratios[theme] = { text: contrast(colors.text, colors.surface), secondary: contrast(colors.muted, colors.surface), button: contrast(colors["on-accent"], colors["accent-strong"]) };
      for (const ratio of Object.values(ratios[theme])) assert.ok(ratio >= 4.5, `${theme}: insufficient text contrast ${ratio}`);
      await noHorizontalOverflow(page, "#view-settings");
      if (["midnight", "sand", "ocean"].includes(theme)) await page.screenshot({ path: path.join(output, `settings-${theme}.png`), caret: "initial" });
    }
    await page.locator('[data-theme-choice="porcelain"]').click();
    await page.locator("#density-select").selectOption("compact");
    await page.locator("#text-size-select").selectOption("large");
    await page.locator("#sidebar-width-select").selectOption("narrow");
    await page.locator("#reduced-motion-checkbox").check();
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setSize(1180, 760);
    });
    await noHorizontalOverflow(page, ".side-rail");
    await noHorizontalOverflow(page, "#view-settings");
    assert.equal(await page.locator(".side-rail").evaluate((element) => getComputedStyle(element).scrollbarWidth), "none");
    await page.screenshot({ path: path.join(output, "settings-porcelain-compact-large.png"), caret: "initial" });
    await page.locator('[data-settings-tab="behavior"]').click();
    await page.locator("#remember-last-view-checkbox").uncheck();
    await page.locator("#default-view-select").selectOption("services");
    await page.locator("#status-interval-select").selectOption("10000");
    await page.locator("#auto-refresh-logs-checkbox").uncheck();
    await page.locator("#maximize-on-start-checkbox").uncheck();
    await saveFinished(page);
    await page.screenshot({ path: path.join(output, "settings-behavior.png"), caret: "initial" });
    const expected = await page.evaluate(() => getCurrentPreferences());
    const userData = await application.evaluate(({ app }) => app.getPath("userData"));
    const file = path.join(userData, "interface-preferences.json");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).preferences, expected);
    // Close immediately after a new click, without waiting for the save receipt.
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator('[data-theme-choice="ocean"]').click();
    expected.theme = "ocean";
    await application.close();
    application = null;
    page = await launch();
    assert.deepEqual(await page.evaluate(() => getCurrentPreferences()), expected);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), false);
    assert.equal(await page.locator("#view-services").evaluate((element) => element.classList.contains("is-current")), true);
    assert.equal(await page.locator(".service-details").first().getAttribute("open"), null);
    await page.locator(".service-details summary").first().click();
    assert.equal(await page.locator(".service-details .service-meta").first().isVisible(), true);
    await page.locator(".service-details summary").first().click();
    await noHorizontalOverflow(page, "#view-services");
    await page.screenshot({ path: path.join(output, "services-after-restart.png"), caret: "initial" });
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator('[data-theme-choice="porcelain"]').click();
    await saveFinished(page);
    await page.getByRole("button", { name: "Клиенты и LMS", exact: true }).click();
    const panel = page.frameLocator("#embedded-panel-frame");
    await panel.locator('html[data-core-theme="porcelain"]').waitFor({ timeout: 60000 });
    assert.equal(await panel.locator("html").getAttribute("data-core-text-size"), "large");
    await panel.getByRole("button", { name: "Мастер создания", exact: true }).click();
    await panel.getByRole("heading", { name: "Данные нового клиента", level: 2 }).waitFor();
    assert.equal(await panel.locator(".operator-cockpit").count(), 0);
    const formColors = await panel.locator(".form-grid input").first().evaluate((input) => ({ background: getComputedStyle(input).backgroundColor, color: getComputedStyle(input).color }));
    assert.notEqual(formColors.background, "rgb(16, 25, 37)");
    assert.notEqual(formColors.color, formColors.background);
    const panelBounds = await panel.locator("body").evaluate((body) => ({ width: body.clientWidth, scroll: body.scrollWidth }));
    assert.ok(panelBounds.scroll <= panelBounds.width + 1);
    await page.screenshot({ path: path.join(output, "master-porcelain.png"), caret: "initial" });
    // A same-frame script cannot impersonate the trusted parent appearance message.
    await panel.locator("body").evaluate(() => window.postMessage({ type: "lms-core:appearance", version: 1, theme: "ember" }, "*"));
    await page.waitForTimeout(100);
    assert.equal(await panel.locator("html").getAttribute("data-core-theme"), "porcelain");
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator('[data-settings-tab="system"]').click();
    assert.equal(await page.locator("#execution-mode-select").inputValue(), "local");
    assert.equal(await page.locator(".settings-caution").isVisible(), true);
    assert.equal(await page.locator("#stop-all-button").isEnabled(), true);
    await page.screenshot({ path: path.join(output, "settings-system.png"), caret: "initial" });
    await page.evaluate(async (preferences) => { persistSettingsPatch(preferences, true); await preferencesWriteQueue; }, original);
    await page.getByRole("button", { name: "Обзор", exact: true }).click();
    await saveFinished(page);
    await page.screenshot({ path: path.join(output, "overview-final.png"), caret: "initial" });
    assert.deepEqual(errors, []);
    assert.equal(createHash("sha256").update(await fs.readFile(ownerPreferenceFile)).digest("hex"), createHash("sha256").update(originalOwnerPreferences).digest("hex"));
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify({ checkedAt: new Date().toISOString(), palettes, contrastRatios: ratios, nativeRestartPersistence: true, maximizedPreference: true, deployAppearance: true, isolatedProfile: true, ownerPreferencesUnchanged: true, noClientWrites: true, errors, screenshots: (await fs.readdir(output)).filter((name) => name !== "profile") }, null, 2));
    console.log(JSON.stringify({ ok: true, output, palettes: palettes.length, nativeRestartPersistence: true, deployAppearance: true }));
  } finally {
    if (application) {
      if (original) {
        try {
          const page = await application.firstWindow();
          await page.evaluate(async (preferences) => { persistSettingsPatch(preferences, true); await preferencesWriteQueue; }, original);
        } catch { /* Preserve diagnostic artifacts even if the renderer itself failed. */ }
      }
      await application.close();
    }
    assert.equal(path.dirname(output), path.join(root, "infra/runtime/local-acceptance/interface-20261029"));
    assert.match(path.basename(output), /^[a-f0-9-]{36}$/i);
    assert.equal(await fs.realpath(profile), path.resolve(profile));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
