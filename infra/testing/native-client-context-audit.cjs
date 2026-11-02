const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "infra/runtime/local-acceptance/native-frame-20261029", randomUUID());
const profile = path.join(output, "profile");
const label = process.env.CORE_CLIENT_CONTEXT_LABEL || "audit";
const hash = (value) => createHash("sha256").update(value).digest("hex");

(async () => {
  const preferenceFile = path.join(process.env.APPDATA, "@lms-core/control-center/interface-preferences.json");
  const original = await fs.readFile(preferenceFile), saved = JSON.parse(original);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, "interface-preferences.json"), JSON.stringify({ ...saved, preferences: { ...saved.preferences, defaultView: "overview", rememberLastView: false, autoFocusPreview: false } }));
  const env = { ...process.env, CORE_TEST_NATIVE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let application, currentDraftField, baselineDraftValue;
  try {
    application = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(__dirname, "native-frame-entry.cjs")], cwd: path.join(root, "apps/control-center"), env, timeout: 30000 });
    const page = await application.firstWindow(), errors = [], writes = [], developmentDiagnostics = [], hydrationErrors = [];
    await application.context().addInitScript(() => {
      if (window.parent !== window) window.addEventListener("message", (event) => {
        if (window.__nativeBlockPanelStateRequest && event.data?.type === "lms-core:panel-state-request") event.stopImmediatePropagation();
      }, true);
    });
    await application.context().route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST" && url.hostname === "127.0.0.1" && ["3002", "3100"].includes(url.port) && url.pathname === "/__nextjs_original-stack-frames") return route.continue();
      if (!["GET", "HEAD"].includes(route.request().method())) return route.abort();
      return route.continue();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) { const item = { method: request.method(), path: new URL(request.url()).pathname }; (item.path === "/__nextjs_original-stack-frames" ? developmentDiagnostics : writes).push(item); } });
    page.on("console", (message) => { if (/hydrat|server rendered HTML/i.test(message.text())) hydrationErrors.push(message.text().slice(0, 2000)); });
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true", null, { timeout: 60000 });
    await page.evaluate(() => { clearInterval(statusPollTimer); clearInterval(logPollTimer); });
    const dashboard = await page.evaluate(() => window.launcherApi.fetchJson("http://127.0.0.1:3001/api/deploy-panel/dashboard"));
    const targetBefore = await page.evaluate(() => window.launcherApi.getRemoteTarget());
    assert.ok(dashboard.clients.length >= 2);
    await page.evaluate((client) => { setStoredPreviewClientId(client.id); setStoredPreviewClientName(client.name); browserClientIdInput.value = client.id; updatePreviewClientCaption(); }, dashboard.clients[0]);
    await page.getByRole("button", { name: "Клиенты и LMS", exact: true }).click();
    const panel = page.frameLocator("#embedded-panel-frame");
    const picker = panel.locator("#client-picker");
    await panel.locator('main[data-panel-ready="true"]').waitFor({ timeout: 60000 });
    await picker.locator(":scope > .client-picker-summary").waitFor({ timeout: 60000 });
    const initialPanelId = await picker.locator('[aria-pressed="true"]').getAttribute("data-client-id");
    const initialCoreId = await page.evaluate(() => getStoredPreviewClientId());
    const other = dashboard.clients.find((client) => client.id !== initialPanelId);
    await picker.locator(":scope > .client-picker-summary").click();
    await picker.getByLabel("Поиск клиента", { exact: true }).fill(other.domain);
    await picker.locator(`[data-client-id="${other.id}"]`).click();
    await panel.locator(".operator-cockpit-main > strong").filter({ hasText: other.name }).waitFor();
    if (label.startsWith("after-")) await page.waitForFunction((id) => getStoredPreviewClientId() === id, other.id);
    const finalCore = await page.evaluate(() => ({ id: getStoredPreviewClientId(), name: getStoredPreviewClientName(), caption: document.querySelector("#stat-preview-client")?.textContent }));
    const frame = page.frames().find((item) => item.parentFrame() === page.mainFrame() && item.url().startsWith("http://127.0.0.1:3002/"));
    const token = randomUUID(); await frame.evaluate((token) => { window.__clientContextFixture = token; }, token);
    const name = panel.locator("#deploy-profile-editor").getByLabel("Название бренда", { exact: true });
    currentDraftField = name;
    const originalBrand = await name.inputValue(); baselineDraftValue = originalBrand; await name.fill("Unsent context fixture");
    await page.evaluate(() => refreshStatuses({ fresh: true }));
    assert.equal(await frame.evaluate(() => window.__clientContextFixture), token);
    assert.equal(await name.inputValue(), "Unsent context fixture");
    let guardTimeoutMs = null;
    const warningLayouts = [];
    if (label.startsWith("after-")) {
      await page.locator("#browser-tab-preview").click();
      await page.locator("#browser-navigation-warning").filter({ hasText: "несохраненные" }).waitFor();
      assert.equal(await page.evaluate(() => activeBrowserMode), "deploy");
      assert.equal(await frame.evaluate(() => window.__clientContextFixture), token);
      await page.locator("#reload-embedded-panel-button").click();
      assert.equal(await frame.evaluate(() => window.__clientContextFixture), token);
      await page.locator("#choose-preview-client-button").click();
      await page.locator(`.modal-client-button[data-client-id="${initialPanelId}"]`).click();
      await page.locator("#preview-client-modal-caption").filter({ hasText: "Сначала сохраните" }).waitFor();
      assert.equal(await page.evaluate(() => getStoredPreviewClientId()), other.id);
      await page.locator("#close-preview-client-modal-button").click();
      assert.equal(await name.inputValue(), "Unsent context fixture");
      await page.screenshot({ path: path.join(output, "navigation-warning-default.png"), caret: "initial" });
      await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setSize(1180, 760); });
      await page.evaluate(async () => { persistSettingsPatch({ theme: "porcelain", textSize: "large" }, true); await preferencesWriteQueue; });
      for (const focus of [false, true]) {
        await page.evaluate((focus) => setBrowserFocusMode(focus), focus);
        const bounds = await page.evaluate(() => ({ viewportHeight: innerHeight, frameBottom: document.querySelector("#embedded-panel-frame").getBoundingClientRect().bottom, frameHeight: document.querySelector("#embedded-panel-frame").clientHeight, scroll: document.querySelector("#view-browser").scrollHeight, height: document.querySelector("#view-browser").clientHeight }));
        assert.ok(bounds.frameBottom <= bounds.viewportHeight && bounds.frameHeight >= 350 && bounds.scroll <= bounds.height + 1, JSON.stringify(bounds));
        warningLayouts.push({ focus, ...bounds });
        await page.screenshot({ path: path.join(output, `navigation-warning-light-${focus ? "focus" : "normal"}.png`), caret: "initial" });
      }
      await page.evaluate(() => setBrowserFocusMode(false));
    }
    await name.fill(originalBrand);
    await panel.locator("#deploy-profile-editor .draft-note").waitFor({ state: "hidden" });
    if (label.startsWith("after-")) {
      await frame.evaluate(() => { window.__nativeBlockPanelStateRequest = true; });
      const started = Date.now();
      await page.locator("#browser-tab-preview").click();
      await page.locator("#browser-navigation-warning").filter({ hasText: "Не удалось проверить" }).waitFor();
      guardTimeoutMs = Date.now() - started;
      assert.ok(guardTimeoutMs >= 2400 && guardTimeoutMs < 5000);
      assert.equal(await page.evaluate(() => activeBrowserMode), "deploy");
      await frame.evaluate(() => { window.__nativeBlockPanelStateRequest = false; });
    }
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    let repositoryClient = await page.locator("#repository-target-client").innerText();
    let editorClientId = null, planClientId = null;
    if (label.startsWith("after-")) {
      await page.waitForFunction((name) => document.querySelector("#repository-target-client")?.textContent === name, other.name);
      repositoryClient = await page.locator("#repository-target-client").innerText();
      assert.equal(finalCore.name, other.name);
      planClientId = await page.evaluate(() => newInstallationPlan?.client.id ?? null);
      assert.ok(planClientId === null || planClientId === other.id);
      assert.deepEqual(await page.evaluate(() => window.launcherApi.getRemoteTarget()), targetBefore);
      await page.getByRole("button", { name: "Клиенты и LMS", exact: true }).click();
      assert.equal(await frame.evaluate(() => window.__clientContextFixture), token);
      await page.locator("#browser-tab-preview").click();
      await page.frameLocator("#embedded-panel-frame").locator(".preview-builder").waitFor({ timeout: 60000 });
      editorClientId = new URL(await page.locator("#embedded-panel-frame").getAttribute("src")).searchParams.get("clientId");
      assert.equal(editorClientId, other.id);
      await page.locator("#browser-tab-deploy").click();
      await page.frameLocator("#embedded-panel-frame").locator("#client-picker > .client-picker-summary strong").filter({ hasText: other.name }).waitFor({ timeout: 60000 });
      assert.equal(await page.evaluate(() => getStoredPreviewClientId()), other.id);
    }
    assert.deepEqual(writes, []); assert.deepEqual(errors, []); assert.deepEqual(hydrationErrors, []);
    const receipt = { checkedAt: new Date().toISOString(), label, actualElectronAndPanel: true, readOnly: true, initial: { coreId: initialCoreId, panelId: initialPanelId }, afterInternalPanelSwitch: { panelId: other.id, panelName: other.name, core: finalCore, repositoryClient }, mismatch: finalCore.id !== other.id, draftRetainedAfterFresh: true, writes, errors };
    Object.assign(receipt, { editorClientId, planClientId, remoteTargetUnchanged: true });
    Object.assign(receipt, { draftNavigationGuard: label.startsWith("after-"), guardTimeoutMs });
    Object.assign(receipt, { developmentDiagnostics, hydrationErrors });
    receipt.warningLayouts = warningLayouts;
    await application.close(); application = null;
    assert.equal(hash(await fs.readFile(preferenceFile)), hash(original));
    await fs.writeFile(path.join(output, "client-context-receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ ...receipt, output }));
  } finally {
    if (application) {
      if (currentDraftField && baselineDraftValue !== undefined) { try { await currentDraftField.fill(baselineDraftValue, { timeout: 2000 }); } catch { /* Only an unsent test field is eligible for cleanup. */ } }
      await application.close();
    }
    assert.equal(path.dirname(output), path.join(root, "infra/runtime/local-acceptance/native-frame-20261029"));
    assert.match(path.basename(output), /^[a-f0-9-]{36}$/i);
    assert.equal(await fs.realpath(profile), path.resolve(profile));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
