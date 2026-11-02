const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const logs = path.join(root, "infra/runtime/logs");
const id = randomUUID();
const fixture = path.join(logs, `acceptance-log-${id}.log`);
const output = path.join(root, "infra/runtime/local-acceptance/logs-20261029", id);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let application;
let original;

(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(fixture, Array.from({ length: 500 }, (_, index) => `Строка журнала ${index}: локальная проверка UTF-8`).join("\n") + "\n", "utf8");
  try {
    application = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(root, "apps/control-center")], env, timeout: 30000 });
    const page = await application.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true", null, { timeout: 60000 });
    original = await page.evaluate(() => getCurrentPreferences());
    await page.evaluate(async (file) => { await showLog(file, "Локальная проверка журнала"); }, fixture);
    assert.ok((await page.locator("#log-panel-content").innerText()).includes("Строка журнала 499"));
    assert.equal((await page.locator("#log-panel-content").innerText()).includes("\ufffd"), false);
    await page.evaluate(() => {
      window.testLogNode = logPanelContent.firstChild;
      logPanelContent.scrollTop = 24;
    });
    await fs.appendFile(fixture, "Добавлена новая запись\n", "utf8");
    await page.locator("#refresh-button").click();
    await page.waitForFunction(() => document.querySelector("#log-panel-content").textContent.includes("Добавлена новая запись"));
    const afterAppend = await page.evaluate(() => ({ retainedNode: logPanelContent.firstChild === window.testLogNode, scroll: logPanelContent.scrollTop }));
    assert.equal(afterAppend.retainedNode, true);
    assert.equal(afterAppend.scroll, 24);
    await page.evaluate(async () => {
      const range = document.createRange();
      range.setStart(logPanelContent.firstChild, 0); range.setEnd(logPanelContent.firstChild, 6);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      await refreshActiveLog();
    });
    assert.equal(await page.locator("#log-update-status").getAttribute("data-tone"), "paused");
    await fs.appendFile(fixture, "Запись после выделения\n", "utf8");
    await page.locator("#log-scroll-bottom").click();
    await page.waitForFunction(() => document.querySelector("#log-panel-content").textContent.includes("Запись после выделения"));
    assert.equal(await page.evaluate(() => window.getSelection().isCollapsed), true);
    assert.equal(await page.locator("#log-panel-content").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2), true);
    await page.evaluate(async () => { window.testStableLogNode = logPanelContent.firstChild; await refreshActiveLog(); });
    assert.equal(await page.evaluate(() => logPanelContent.firstChild === window.testStableLogNode), true);
    await page.screenshot({ path: path.join(output, "journal.png"), caret: "initial" });
    await page.evaluate(async (directory) => { await showLog(directory, "Проверка недоступного журнала"); }, logs);
    assert.equal(await page.locator("#log-update-status").getAttribute("data-tone"), "error");
    assert.ok((await page.locator("#log-panel-content").innerText()).includes("Журнал недоступен"));
    await page.evaluate(async (file) => { await showLog(file, "Локальная проверка журнала"); }, fixture);
    assert.equal(await page.locator("#log-update-status").getAttribute("data-tone"), "normal");
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify({ checkedAt: new Date().toISOString(), realElectron: true, realIpc: true, utf8: true, unchangedDom: true, appendedDom: true, scrollRetained: true, selectionPaused: true, jumpToBottom: true, errorRecovery: true, fixtureOnly: true }, null, 2));
    console.log(JSON.stringify({ ok: true, output, realIpc: true, scrollRetained: true, selectionPaused: true }));
  } finally {
    if (application) {
      if (original) {
        try { const page = await application.firstWindow(); await page.evaluate(async (preferences) => { persistSettingsPatch(preferences, true); await preferencesWriteQueue; }, original); }
        catch { /* Preserve the original test error if its renderer is already unavailable. */ }
      }
      await application.close();
    }
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(logs));
    assert.ok(path.basename(fixture).startsWith("acceptance-log-"));
    await fs.rm(fixture, { force: true });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
