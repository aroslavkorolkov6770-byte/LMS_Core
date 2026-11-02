const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const id = randomUUID();
const output = path.join(root, "infra/runtime/local-acceptance/native-frame-20261029", id);
const profile = path.join(output, "profile");
const hash = (value) => createHash("sha256").update(value).digest("hex");

(async () => {
  const preferenceFile = path.join(process.env.APPDATA, "@lms-core/control-center/interface-preferences.json");
  const original = await fs.readFile(preferenceFile), preferences = JSON.parse(original);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, "interface-preferences.json"), JSON.stringify({ ...preferences, preferences: { ...preferences.preferences, defaultView: "overview", rememberLastView: false } }));
  const env = { ...process.env, CORE_TEST_NATIVE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let application, nativeDraftField;
  try {
    application = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(__dirname, "native-frame-entry.cjs")], cwd: path.join(root, "apps/control-center"), env, timeout: 30000 });
    const page = await application.firstWindow(), errors = [], writes = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) writes.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true", null, { timeout: 60000 });
    assert.equal((await application.evaluate(({ app }) => app.getPath("userData"))).toLowerCase(), profile.toLowerCase());
    await page.evaluate(async () => { clearInterval(statusPollTimer); clearInterval(logPollTimer); if (statusRefreshPromise) await statusRefreshPromise; });
    const healthy = await page.evaluate(() => lastStatuses.length === 4 && lastStatuses.every((service) => service.healthState === "healthy")); assert.equal(healthy, true);
    assert.equal(await page.locator("#embedded-panel-frame").getAttribute("src"), "about:blank");
    const tabsBefore = await application.evaluate(({ app }) => app.getAppMetrics().filter((process) => process.type === "Tab").length);
    await page.getByRole("button", { name: "Клиенты и LMS", exact: true }).click();
    const panel = page.frameLocator("#embedded-panel-frame");
    await panel.getByRole("button", { name: "Мастер создания", exact: true }).click({ timeout: 60000 });
    const name = panel.locator("#client-editor").getByLabel("Название клиента", { exact: true });
    nativeDraftField = name;
    await name.fill("Unsent native frame fixture");
    const frame = page.frames().find((item) => item.parentFrame() === page.mainFrame() && item.url().startsWith("http://127.0.0.1:3002/"));
    const token = randomUUID(); await frame.evaluate((token) => { window.__nativeFrameFixture = token; }, token);
    let navigations = 0;
    page.on("framenavigated", (item) => { if (item === frame) navigations++; });
    const tabsAfter = await application.evaluate(({ app }) => app.getAppMetrics().filter((process) => process.type === "Tab").length);
    for (let index = 0; index < 3; index++) {
      // Simulate only the rendered status. Actual services are never stopped, replaced or falsified in main.
      await page.evaluate(() => { const statuses = structuredClone(lastStatuses); Object.assign(statuses.find((service) => service.id === "deploy-panel"), { healthState: "unhealthy", message: "Acceptance UI-only transient timeout" }); renderStatuses(statuses); });
      assert.equal(await page.locator("#embedded-panel-frame").isVisible(), false);
      assert.equal(await frame.evaluate(() => window.__nativeFrameFixture), token);
      await page.getByRole("button", { name: "Повторить проверку", exact: true }).click();
      await page.waitForFunction(() => lastStatuses.find((service) => service.id === "deploy-panel")?.healthState === "healthy");
      assert.equal(await page.locator("#embedded-panel-frame").isVisible(), true);
      assert.equal(await name.inputValue(), "Unsent native frame fixture");
      assert.equal(await frame.evaluate(() => window.__nativeFrameFixture), token);
      await page.getByRole("button", { name: "Обзор", exact: true }).click();
      await page.getByRole("button", { name: "Клиенты и LMS", exact: true }).click();
      assert.equal(await frame.evaluate(() => window.__nativeFrameFixture), token);
    }
    assert.equal(navigations, 0); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, "native-retained-wizard.png"), caret: "initial" });
    // Discard only this test's unsent field before closing; do not bypass the real beforeunload protection.
    await name.fill("");
    assert.equal(await panel.locator("#client-editor").getByRole("button", { name: "Очистить форму", exact: true }).isDisabled(), true);
    await application.close(); application = null;
    assert.equal(hash(await fs.readFile(preferenceFile)), hash(original));
    const receipt = { checkedAt: new Date().toISOString(), realElectronOriginalMainAndPanel: true, isolatedProfileOnly: true, ownerPreferencesUnchanged: true, initialFourRealServicesHealthy: healthy, uiOnlyTransientSimulation: true, servicesNeverStopped: true, draftAndDocumentRetainedAcrossThreeRecoveries: true, extraFrameNavigations: navigations, tabProcessCounts: { beforeFirstOpen: tabsBefore, afterFirstOpen: tabsAfter }, writes, errors };
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ ...receipt, output }));
  } finally {
    if (application) {
      if (nativeDraftField) { try { await nativeDraftField.fill(""); } catch { /* Preserve the original test failure. */ } }
      await application.close();
    }
    assert.equal(path.dirname(output), path.join(root, "infra/runtime/local-acceptance/native-frame-20261029"));
    assert.match(path.basename(output), /^[a-f0-9-]{36}$/i);
    assert.equal(await fs.realpath(profile), path.resolve(profile));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
