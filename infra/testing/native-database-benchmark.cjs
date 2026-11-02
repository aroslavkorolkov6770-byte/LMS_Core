const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, "infra/runtime/local-acceptance/database-20261029", randomUUID());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const label = process.env.CORE_DB_BENCHMARK_LABEL || "unspecified";
let application;
let originalPreferences;

(async () => {
  await fs.mkdir(output, { recursive: true });
  try {
    application = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(root, "apps/control-center")], env, timeout: 30000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true", null, { timeout: 60000 });
    const preferences = await page.evaluate(() => getCurrentPreferences());
    originalPreferences = { ...preferences };
    if (process.env.CORE_DB_RESTORE_TEXT_SIZE === "normal") originalPreferences.textSize = "normal";
    const samples = [];
    for (const table of ["clients", "users", "courses"]) {
      const sample = await page.evaluate(async (name) => {
        const started = performance.now();
        const result = await window.launcherApi.getPostgresSnapshot(name);
        return { table: name, milliseconds: Math.round(performance.now() - started), tableCount: result.tables.length, displayedRows: result.rows.length, count: result.tables.find((table) => table.name === name)?.rows };
      }, table);
      assert.ok(sample.displayedRows <= 50);
      assert.ok(Number.isSafeInteger(sample.count));
      samples.push(sample);
    }
    await page.getByRole("button", { name: "База данных", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#database-preview-table").classList.contains("is-loading"), null, { timeout: 60000 });
    await page.screenshot({ path: path.join(output, "database.png"), caret: "initial" });
    if (label.startsWith("after-")) {
      await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setSize(1180, 760); });
      await page.evaluate(() => persistSettingsPatch({ textSize: "large" }));
      const geometry = await page.evaluate(() => {
        const list = document.querySelector(".database-table-list").getBoundingClientRect();
        const preview = document.querySelector(".database-table-preview").getBoundingClientRect();
        return { sideBySide: list.right <= preview.left, fitsHeight: list.bottom <= innerHeight, scrollable: document.querySelector(".database-table-list").scrollHeight > list.height, list: list.toJSON(), preview: preview.toJSON(), viewport: { width: innerWidth, height: innerHeight } };
      });
      await page.screenshot({ path: path.join(output, "database-small-debug.png"), caret: "initial" });
      assert.equal(geometry.sideBySide, true, JSON.stringify(geometry));
      assert.equal(geometry.fitsHeight, true, JSON.stringify(geometry));
      assert.equal(geometry.scrollable, true, JSON.stringify(geometry));
      for (const theme of ["midnight", "graphite", "ocean", "forest", "ember", "sand", "porcelain", "mist"]) {
        await page.evaluate((theme) => persistSettingsPatch({ theme }), theme);
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".database-table-button span")).color === getComputedStyle(document.body).color, null, { timeout: 5000 });
      }
      await page.screenshot({ path: path.join(output, "database-small-light.png"), caret: "initial" });
      await page.locator('[data-table-name="users"]').click();
      await page.locator('[data-table-name="courses"]').click();
      await page.locator('[data-table-name="clients"]').click();
      await page.waitForFunction(() => !databaseReadBusy && !databasePendingRead, null, { timeout: 30000 });
      assert.equal(await page.locator("#database-selected-table").innerText(), "clients");
      assert.equal(await page.locator(".database-table-button.is-current").count(), 1);
    }
    await page.evaluate(async (original) => { persistSettingsPatch(original, true); await preferencesWriteQueue; }, originalPreferences);
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify({ label, checkedAt: new Date().toISOString(), realElectron: true, readOnly: true, samples }, null, 2));
    console.log(JSON.stringify({ output, label, samples }));
  } finally {
    if (application) {
      if (originalPreferences) {
        try { const page = await application.firstWindow(); await page.evaluate(async (preferences) => { persistSettingsPatch(preferences, true); await preferencesWriteQueue; }, originalPreferences); }
        catch { /* Preserve the original failure if the renderer is unavailable. */ }
      }
      await application.close();
    }
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
