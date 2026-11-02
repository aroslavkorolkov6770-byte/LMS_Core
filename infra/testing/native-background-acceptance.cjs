const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "infra/runtime/local-acceptance/background-20261029", randomUUID());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await fs.mkdir(output, { recursive: true });
  const preferenceFile = path.join(process.env.APPDATA, "@lms-core/control-center/interface-preferences.json");
  const beforeHash = createHash("sha256").update(await fs.readFile(preferenceFile)).digest("hex");
  let application;
  try {
    application = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(__dirname, "native-status-entry.cjs")], cwd: path.join(root, "apps/control-center"), env, timeout: 30000 });
    const page = await application.firstWindow(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true", null, { timeout: 60000 });
    const interval = await page.evaluate(async () => { if (statusRefreshPromise) await statusRefreshPromise; return getCurrentPreferences().statusInterval; });
    assert.ok([5000, 10000, 30000].includes(interval));
    async function begin(phase) {
      return application.evaluate((_electron, phase) => { const metrics = globalThis.__coreProbeMetrics; if (!metrics) throw new Error("Native hook missing"); metrics.phase = phase; metrics.events = []; return { cpu: process.cpuUsage(), at: performance.now() }; }, phase);
    }
    async function sample(start) {
      return application.evaluate(({ app }, start) => {
        const cpu = process.cpuUsage(start.cpu), elapsedMs = performance.now() - start.at;
        const counts = {}; for (const event of globalThis.__coreProbeMetrics.events) counts[`${event.kind}:${event.label}`] = (counts[`${event.kind}:${event.label}`] || 0) + 1;
        return { elapsedMs: Math.round(elapsedMs), counts, mainCpuMs: Math.round((cpu.user + cpu.system) / 1000), mainCpuPercent: Math.round((cpu.user + cpu.system) * 10 / elapsedMs) / 100, electronProcesses: app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpuPercent: cpu.percentCPUUsage, workingSetKiB: memory.workingSetSize })) };
      }, start);
    }
    const visibleStart = await begin("visible");
    const visibleDeadline = Date.now() + 2 * interval + 10000;
    while ((await application.evaluate(() => globalThis.__coreProbeMetrics.events.filter((event) => event.kind === "ipc" && event.label === "statuses-normal").length)) < 2) {
      if (Date.now() > visibleDeadline) throw new Error("Visible native window did not run its configured status polling");
      await delay(250);
    }
    await page.evaluate(async () => { if (statusRefreshPromise) await statusRefreshPromise; });
    const visible = await sample(visibleStart);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    try { await page.waitForFunction(() => nativeWindowVisible === false, null, { timeout: 10000, polling: 100 }); }
    catch (error) {
      console.log(JSON.stringify({ nativeVisibility: await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), minimized: window.isMinimized() }))), documentVisibility: await page.evaluate(() => ({ hidden: document.hidden, state: document.visibilityState })) }));
      throw error;
    }
    await page.evaluate(async () => { if (statusRefreshPromise) await statusRefreshPromise; });
    const hiddenStart = await begin("hidden");
    const hiddenDeadline = Date.now() + 2 * interval + 700;
    while (Date.now() < hiddenDeadline) {
      assert.equal(await page.evaluate(() => nativeWindowVisible), false);
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
      await delay(250);
    }
    const hidden = await sample(hiddenStart);
    assert.deepEqual(hidden.counts, {}, "A natively hidden window must not perform local status/SQL/HTTP polling");
    const resumeStart = await begin("resume");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await page.waitForFunction(() => nativeWindowVisible && !document.hidden, null, { timeout: 10000, polling: 100 });
    const resumeDeadline = Date.now() + 10000;
    while (!(await application.evaluate(() => globalThis.__coreProbeMetrics.events.some((event) => event.kind === "ipc" && event.label === "statuses-fresh")))) {
      if (Date.now() > resumeDeadline) throw new Error("Returning to the visible window did not request fresh statuses");
      await delay(100);
    }
    await page.evaluate(async () => { if (statusRefreshPromise) await statusRefreshPromise; });
    const resume = await sample(resumeStart);
    const healthy = await page.evaluate(() => lastStatuses.length === 4 && lastStatuses.every((service) => service.healthState === "healthy")); assert.equal(healthy, true);
    assert.equal(resume.counts["ipc:statuses-fresh"], 1);
    for (const port of [3100, 3002]) assert.equal(resume.counts[`fetch:${port}`], 1);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await page.waitForFunction(() => nativeWindowVisible === false, null, { timeout: 10000, polling: 100 });
    await page.evaluate(async () => { if (statusRefreshPromise) await statusRefreshPromise; });
    const minimizedStart = await begin("minimized");
    await delay(2 * interval + 700);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true);
    const minimized = await sample(minimizedStart);
    assert.deepEqual(minimized.counts, {}, "A minimized native window must not poll status/SQL/HTTP");
    const restoreStart = await begin("restore");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await page.waitForFunction(() => nativeWindowVisible && !document.hidden, null, { timeout: 10000, polling: 100 });
    const restoreDeadline = Date.now() + 10000;
    while (!(await application.evaluate(() => globalThis.__coreProbeMetrics.events.some((event) => event.kind === "ipc" && event.label === "statuses-fresh")))) {
      if (Date.now() > restoreDeadline) throw new Error("Restoring the window did not request fresh statuses");
      await delay(100);
    }
    await page.evaluate(async () => { if (statusRefreshPromise) await statusRefreshPromise; });
    const restored = await sample(restoreStart);
    assert.equal(restored.counts["ipc:statuses-fresh"], 1);
    for (const port of [3100, 3002]) assert.equal(restored.counts[`fetch:${port}`], 1);
    assert.deepEqual(errors, []);
    await application.close(); application = null;
    assert.equal(createHash("sha256").update(await fs.readFile(preferenceFile)).digest("hex"), beforeHash);
    const receipt = { checkedAt: new Date().toISOString(), actualElectronWindow: true, instrumentedOriginalMainViaTestEntry: true, configuredIntervalMs: interval, visible, hidden, resume, minimized, restored, allFourHealthyAfterResume: true, unchangedOwnerPreferences: true, noStartStopOrExternalActions: true, mainCpuOnlyNotServerCpu: true, cpuUnderDebuggerNotProductionBaseline: true, errors };
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ ...receipt, output }));
  } finally { if (application) await application.close(); }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
