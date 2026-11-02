const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, "infra/runtime/local-acceptance/native-frame-20261029", randomUUID());
const profile = path.join(output, "profile");
const preferences = path.join(process.env.APPDATA, "@lms-core/control-center/interface-preferences.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scope = process.env.CORE_CLOSE_DRAFT_SCOPE || "panel";
assert.ok(["panel", "editor"].includes(scope), "Unknown draft audit scope");

// Observe the real close policy without adding a preventDefault handler or changing production code.
(async () => {
  const original = await fs.readFile(preferences);
  const saved = JSON.parse(original);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, "interface-preferences.json"), JSON.stringify({ ...saved, preferences: { ...saved.preferences, defaultView: "overview", rememberLastView: false } }));
  const env = { ...process.env, CORE_TEST_NATIVE_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let application, draft, baseline;
  const errors = [], writes = [], dialogs = [], unloadEvents = [];
  let allowLocalDraftDiscard = false;
  try {
    application = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(__dirname, "native-frame-entry.cjs")], cwd: path.join(root, "apps/control-center"), env, timeout: 30000 });
    const page = await application.firstWindow();
    await application.evaluate(({ dialog }) => {
      const original = dialog.showMessageBoxSync.bind(dialog);
      globalThis.__coreUnloadChoice = 0;
      globalThis.__coreUnloadPrompts = [];
      dialog.showMessageBoxSync = (...args) => {
        const options = args[1] || args[0];
        if (options?.title !== "Несохраненные изменения") return original(...args);
        globalThis.__coreUnloadPrompts.push({ buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId, choice: globalThis.__coreUnloadChoice });
        return globalThis.__coreUnloadChoice;
      };
    });
    await application.context().addInitScript(() => {
      if (window.parent === window) return;
      const add = window.addEventListener, remove = window.removeEventListener;
      const handlers = new Set();
      window.__closeAuditHandlers = handlers;
      window.addEventListener = function (type, listener, options) {
        if (type === "beforeunload") handlers.add(listener);
        return Reflect.apply(add, this, [type, listener, options]);
      };
      window.removeEventListener = function (type, listener, options) {
        if (type === "beforeunload") handlers.delete(listener);
        return Reflect.apply(remove, this, [type, listener, options]);
      };
      window.__closeAuditObserve = () => Reflect.apply(add, window, ["beforeunload", (event) => console.log("CORE_CLOSE_AUDIT:" + JSON.stringify({ prevented: event.defaultPrevented, returnValue: event.returnValue }))]);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.text().startsWith("CORE_CLOSE_AUDIT:")) unloadEvents.push(JSON.parse(message.text().slice("CORE_CLOSE_AUDIT:".length))); });
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      // Electron owns beforeunload cancellation. CDP can emit an already-dismissed pseudo-dialog.
      if (dialog.type() !== "beforeunload") void (allowLocalDraftDiscard ? dialog.accept() : dialog.dismiss()).catch((error) => errors.push(error.message));
    });
    await application.context().route("**/*", (route) => {
      const request = route.request(), url = new URL(request.url());
      if (["file:", "data:"].includes(url.protocol)) return route.continue();
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
      if (["GET", "HEAD"].includes(request.method()) || url.pathname === "/__nextjs_original-stack-frames") return route.continue();
      writes.push({ method: request.method(), path: url.pathname });
      return route.abort();
    });
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true", null, { timeout: 60000 });
    await page.evaluate(() => { clearInterval(statusPollTimer); clearInterval(logPollTimer); });
    const dashboard = await page.evaluate(() => window.launcherApi.fetchJson("http://127.0.0.1:3001/api/deploy-panel/dashboard"));
    assert.ok(dashboard.clients.length > 0);
    await page.evaluate((client) => { setStoredPreviewClientId(client.id); setStoredPreviewClientName(client.name); browserClientIdInput.value = client.id; updatePreviewClientCaption(); }, dashboard.clients[0]);
    await page.getByRole("button", { name: "Клиенты и LMS", exact: true }).click();
    const panel = page.frameLocator("#embedded-panel-frame");
    await panel.locator('main[data-panel-ready="true"]').waitFor({ timeout: 60000 });
    if (scope === "editor") {
      await page.locator("#browser-tab-preview").click();
      await panel.locator(".preview-builder").waitFor({ timeout: 60000 });
      await panel.locator('.preview-builder[data-editor-ready="true"]').waitFor({ timeout: 45000 });
      draft = panel.locator(".field").filter({ has: panel.locator("label", { hasText: /^Главный заголовок$/ }) }).locator("input");
    } else {
      await panel.getByRole("button", { name: "Карточка клиента", exact: true }).click();
      draft = panel.locator("#deploy-profile-editor").getByLabel("Название бренда", { exact: true });
    }
    baseline = await draft.inputValue();
    await draft.click();
    await draft.fill("Unsent native close fixture");
    if (scope === "panel") await panel.locator("#deploy-profile-editor .draft-note").waitFor();
    const token = randomUUID();
    const expectedPort = scope === "editor" ? "3100" : "3002";
    const frame = page.frames().find((item) => item.parentFrame() === page.mainFrame() && item.url().startsWith(`http://127.0.0.1:${expectedPort}/`));
    await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await frame.evaluate((value) => { window.__nativeCloseFixture = value; }, token);
    if (scope === "editor") {
      await page.locator("#browser-tab-deploy").click();
      await page.locator("#browser-navigation-warning").filter({ hasText: "несохраненные" }).waitFor();
      assert.equal(await page.evaluate(() => activeBrowserMode), "preview");
      await page.locator("#reload-embedded-panel-button").click();
      assert.equal(await frame.evaluate(() => window.__nativeCloseFixture), token);
      assert.equal(await draft.inputValue(), "Unsent native close fixture");
      await page.locator("#choose-preview-client-button").click();
      const other = dashboard.clients.find((client) => client.id !== dashboard.clients[0].id);
      assert.ok(other);
      await page.locator(`.modal-client-button[data-client-id="${other.id}"]`).click();
      await page.locator("#preview-client-modal-caption").filter({ hasText: "Сначала сохраните" }).waitFor();
      assert.equal(await page.evaluate(() => getStoredPreviewClientId()), dashboard.clients[0].id);
      await page.locator("#close-preview-client-modal-button").click();
      await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setSize(1180, 760); });
      const bounds = await frame.evaluate(() => {
        const root = document.querySelector(".preview-builder"), top = document.querySelector(".builder-topbar"), layout = document.querySelector(".builder-layout");
        return { width: root.clientWidth, scroll: root.scrollWidth, height: innerHeight, headerBottom: top.getBoundingClientRect().bottom, layoutTop: layout.getBoundingClientRect().top, layoutBottom: layout.getBoundingClientRect().bottom, hiddenInspectorScrollbar: getComputedStyle(document.querySelector(".inspector")).scrollbarWidth };
      });
      assert.ok(bounds.scroll <= bounds.width + 1 && bounds.layoutTop >= bounds.headerBottom - 1 && bounds.layoutBottom <= bounds.height + 1, JSON.stringify(bounds));
      assert.equal(bounds.hiddenInspectorScrollbar, "none");
    }
    const beforeClose = await frame.evaluate(() => ({ handlers: window.__closeAuditHandlers?.size ?? null, userActivated: navigator.userActivation.hasBeenActive, visible: document.visibilityState }));
    assert.equal(await draft.inputValue(), "Unsent native close fixture");
    await frame.evaluate(() => window.__closeAuditObserve?.());
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.__coreCloseAudit = { closeRequested: false, preventedUnload: 0, closed: false };
      window.on("close", () => { globalThis.__coreCloseAudit.closeRequested = true; });
      window.on("closed", () => { globalThis.__coreCloseAudit.closed = true; });
      window.webContents.on("will-prevent-unload", () => { globalThis.__coreCloseAudit.preventedUnload++; });
    });
    const closed = page.waitForEvent("close", { timeout: 2000 }).then(() => true, () => false);
    try { await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); }); }
    catch (error) { if (!page.isClosed()) throw error; }
    const windowClosed = await closed;
    let observation = null, draftRetained = false, nativePrompts = [];
    if (!windowClosed) {
      observation = await application.evaluate(() => globalThis.__coreCloseAudit);
      nativePrompts = await application.evaluate(() => globalThis.__coreUnloadPrompts);
      assert.equal(nativePrompts.length, 1);
      assert.deepEqual(nativePrompts[0], { buttons: ["Остаться", "Уйти без сохранения"], defaultId: 0, cancelId: 0, choice: 0 });
      draftRetained = await draft.inputValue() === "Unsent native close fixture" && await frame.evaluate(() => window.__nativeCloseFixture) === token;
      await page.screenshot({ path: path.join(output, "native-close-retained.png"), caret: "initial" });
      await draft.fill(baseline);
      if (scope === "panel") await panel.locator("#deploy-profile-editor .draft-note").waitFor({ state: "hidden" });
      if (scope === "editor") {
        allowLocalDraftDiscard = true;
        const discard = panel.getByRole("button", { name: "Отменить правки", exact: true });
        if (await discard.isEnabled()) await discard.click();
        await discard.waitFor();
        await page.waitForFunction(() => document.querySelector("#embedded-panel-frame") !== null);
        assert.equal(await discard.isDisabled(), true);
        await frame.waitForFunction(() => window.__closeAuditHandlers.size === 0);
        allowLocalDraftDiscard = false;
        assert.equal(await page.evaluate(() => canLeaveDeployPanel()), true);
      }
      await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      draft = null;
      // This is an explicit fixture-only discard choice, not a production policy override.
      await application.evaluate(() => { globalThis.__coreUnloadChoice = 1; });
      await application.close();
    }
    application = null;
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    assert.equal(hash(await fs.readFile(preferences)), hash(original));
    assert.equal(draftRetained, true);
    const receipt = { checkedAt: new Date().toISOString(), actualElectron: true, isolatedProfile: true, noProductionPolicyOverride: true, nativeDialogResponseStubbed: true, nativePrompts, scope, editorNavigationAndReloadAndClientGuard: scope === "editor", localDiscardClearsDraftWithoutWrite: scope === "editor", beforeClose, unloadEvents, windowClosed, draftRetained, observation, dialogs, writes, errors, ownerPreferencesUnchanged: true, conclusion: "Stay retained the unsent draft; confirmed local discard restores clean state" };
    await fs.writeFile(path.join(output, "close-draft-receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ ...receipt, output }));
  } finally {
    if (application) {
      if (draft && baseline !== undefined) { try { await draft.fill(baseline, { timeout: 2000 }); } catch { /* Restore only this audit's unsent field if its page still exists. */ } }
      try { await application.evaluate(() => { globalThis.__coreUnloadChoice = 1; }); } catch { /* The isolated process may already have exited. */ }
      await application.close();
    }
    assert.equal(path.dirname(output), path.join(root, "infra/runtime/local-acceptance/native-frame-20261029"));
    assert.match(path.basename(output), /^[a-f0-9-]{36}$/i);
    assert.equal(await fs.realpath(profile), path.resolve(profile));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
