"use strict";
const { _electron } = require("playwright");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const run = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const executablePath = path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe");
async function pilotIdentity() {
  const result = await run("powershell.exe", ["-NoProfile", "-Command", "$p=Get-Process -Id 9096 -ErrorAction Stop; [string]$p.Id+'|'+$p.StartTime.ToUniversalTime().Ticks.ToString()"], { windowsHide: true, timeout: 10000 });
  return result.stdout.trim();
}
async function main() {
  const directory = path.join(root, "infra/runtime/local-acceptance/startup-20261029", crypto.randomUUID());
  await fs.mkdir(directory, { recursive: true });
  const profile = path.join(directory, "profile"); await fs.mkdir(profile);
  const ownerPreferenceFile = path.join(process.env.APPDATA, "@lms-core/control-center/interface-preferences.json");
  const originalOwnerPreferences = await fs.readFile(ownerPreferenceFile), saved = JSON.parse(originalOwnerPreferences);
  await fs.writeFile(path.join(profile, "interface-preferences.json"), JSON.stringify({ ...saved, preferences: { ...saved.preferences, defaultView: "overview", rememberLastView: false } }));
  const originalPilot = await pilotIdentity();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  env.CORE_TEST_NATIVE_PROFILE = profile;
  let app, page, originalPreferences, stopRequested = false, recovered = false, stage = "bootstrap";
  const metrics = {};
  try {
    const launchedAt = performance.now();
    app = await _electron.launch({ executablePath, args: [path.join(__dirname, "native-frame-entry.cjs")], env, timeout: 60000 });
    page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForFunction(() => Boolean(window.launcherApi));
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true");
    originalPreferences = await page.evaluate(() => getCurrentPreferences());
    metrics.windowReadyMs = Math.round(performance.now() - launchedAt);
    stage = "stop-core";
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator('[data-settings-tab="system"]').click();
    const stoppedAt = performance.now();
    stopRequested = true;
    await page.locator("#stop-all-button").click();
    await page.waitForFunction(() => !isBusy, null, { timeout: 180000 });
    assert.equal((await page.evaluate(() => window.launcherApi.getStatuses())).every((state) => !state.running), true);
    metrics.stopMs = Math.round(performance.now() - stoppedAt);
    assert.equal(await pilotIdentity(), originalPilot, "Stopping Core must not stop the independent pilot");
    console.log("Native Core: own services stopped; independent pilot unchanged.");
    stage = "start-core";
    await page.getByRole("button", { name: "Обзор", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#start-all-button").disabled);
    const startedAt = performance.now();
    await page.locator("#start-all-button").click();
    await page.waitForFunction(() => !isBusy, null, { timeout: 240000 });
    const ready = await page.evaluate(() => window.launcherApi.getStatuses());
    assert.equal(ready.length, 4); assert.equal(ready.every((state) => state.healthState === "healthy"), true, "Every actual Core service must pass its identity check");
    recovered = true;
    await page.waitForFunction(() => document.querySelector("#view-browser").classList.contains("is-current"), null, { timeout: 45000 });
    metrics.coldStartMs = Math.round(performance.now() - startedAt);
    assert.ok((await page.locator("#embedded-panel-frame").getAttribute("src")).startsWith("http://127.0.0.1:3002/"));
    const states = await page.evaluate(() => window.launcherApi.getStatuses());
    assert.equal(states.find((state) => state.id === "lms-web").port, 3100);
    assert.equal(new URL(await page.evaluate(() => buildBrowserUrl("preview"))).port, "3100");
    assert.equal(await pilotIdentity(), originalPilot);
    assert.equal(crypto.createHash("sha256").update(await fs.readFile(ownerPreferenceFile)).digest("hex"), crypto.createHash("sha256").update(originalOwnerPreferences).digest("hex"));
    const health = await fetch("http://127.0.0.1:3100/api/health").then((response) => response.json()); assert.equal(health.service, "lms-core-lms-web");
    stage = "panel-interaction";
    const panel = page.frameLocator("#embedded-panel-frame");
    await panel.getByRole("button", { name: "Карточка клиента", exact: true }).click({ timeout: 90000 });
    await panel.getByRole("button", { name: "Карточка клиента", exact: true }).evaluate((button) => { if (!button.classList.contains("workspace-tab-active")) throw Error("Panel did not respond to click"); });
    await panel.getByRole("button", { name: "Мастер создания", exact: true }).click();
    await panel.getByRole("heading", { name: "Данные нового клиента", exact: true, level: 2 }).waitFor();
    metrics.interactivePanelMs = Math.round(performance.now() - startedAt);
    await page.getByRole("button", { name: "Обзор", exact: true }).click();
    assert.equal(await page.locator("#start-all-button").innerText(), "Открыть панель клиентов");
    await page.screenshot({ path: path.join(directory, "overview-ready.png") });
    await page.locator("#start-all-button").click();
    await page.waitForFunction(() => document.querySelector("#view-browser").classList.contains("is-current"));
    assert.equal(await pilotIdentity(), originalPilot);
    await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify({ format: "lms-core-native-startup-acceptance-v1", checkedAt: new Date().toISOString(), realElectron: true,
      realIpc: true, coldStopAndStartButtons: true, allFourHealthy: true, editorPort: 3100, independentPilotUnchanged: true, repeatOpensPanel: true,
      startupScope: "Stopped local services; existing dependency/build caches retained, not an OS-cold benchmark",
      isolatedProfile: true, ownerPreferencesUnchanged: true,
      benchmarkLabel: /^[a-z0-9-]{1,40}$/.test(process.env.CORE_STARTUP_LABEL || "") ? process.env.CORE_STARTUP_LABEL : "acceptance", metrics, states }, null, 2));
    console.log("STARTUP_METRICS: " + JSON.stringify(metrics));
    console.log("NATIVE_STARTUP_ACCEPTANCE_PASSED: " + path.join(directory, "receipt.json"));
  } catch (error) {
    const states = page && !page.isClosed() ? await page.evaluate(() => window.launcherApi.getStatuses()).catch(() => []) : [];
    await fs.writeFile(path.join(directory, "failure.json"), JSON.stringify({ stage, error: error.message, states }, null, 2));
    throw error;
  } finally {
    if (stopRequested && !recovered && page && !page.isClosed()) {
      try { const states = await page.evaluate(() => window.launcherApi.startAll()); assert.ok(states.length === 4 && states.every((state) => state.healthState === "healthy")); }
      catch { console.error("The failed startup test could not confirm recovery; inspect the preserved failure receipt and restore only Core services."); }
    }
    if (page && !page.isClosed() && originalPreferences) {
      await page.evaluate(async (preferences) => { persistSettingsPatch(preferences, true); await preferencesWriteQueue; }, originalPreferences);
      assert.deepEqual(await page.evaluate(() => getCurrentPreferences()), originalPreferences);
    }
    if (app) await app.close();
    assert.equal(path.dirname(directory), path.join(root, "infra/runtime/local-acceptance/startup-20261029"));
    assert.match(path.basename(directory), /^[a-f0-9-]{36}$/i);
    assert.equal(await fs.realpath(profile), path.resolve(profile));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
