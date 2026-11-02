const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "infra/runtime/local-acceptance/status-20261029", randomUUID());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const label = process.env.CORE_STATUS_BENCHMARK_LABEL || "unspecified";

(async () => {
  await fs.mkdir(output, { recursive: true });
  const profile = path.join(process.env.APPDATA, "@lms-core/control-center");
  const preferencePath = path.join(profile, "interface-preferences.json");
  const preferencesHash = createHash("sha256").update(await fs.readFile(preferencePath)).digest("hex");
  let app;
  try {
    app = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(__dirname, "native-status-entry.cjs")], cwd: path.join(root, "apps/control-center"), env, timeout: 30000 });
    const page = await app.firstWindow();
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true", null, { timeout: 60000 });
    assert.equal(await app.evaluate(() => Boolean(globalThis.__coreProbeMetrics)), true, `The owned main-process hook must actually be active: ${JSON.stringify(await app.evaluate(() => globalThis.__coreProbeHookLoaded || null))}`);
    assert.equal((await app.evaluate(({ app }) => app.getPath("userData"))).toLowerCase(), profile.toLowerCase());
    await page.evaluate(async () => { clearInterval(statusPollTimer); clearInterval(logPollTimer); if (statusRefreshPromise) await statusRefreshPromise; });
    const cases = [];
    for (const test of [{ name: "warm-normal", mode: "sequential", fresh: false, count: 3 }, { name: "manual-fresh", mode: "sequential", fresh: true, count: 3 }, { name: "normal-burst", mode: "burst", fresh: false, count: 10 }, { name: "fresh-burst", mode: "burst", fresh: true, count: 10 }, { name: "normal-then-fresh-burst", mode: "mixed", fresh: true, count: 10 }, { name: "renderer-normal-fresh-burst", mode: "renderer", fresh: true, count: 10 }]) {
      await app.evaluate((_electron, phase) => { globalThis.__coreProbeMetrics.phase = phase; globalThis.__coreProbeMetrics.events = []; }, test.name);
      const result = await page.evaluate(async (test) => {
        const started = performance.now(), samples = [];
        if (test.mode === "sequential") {
          for (let index = 0; index < test.count; index++) { const before = performance.now(); const statuses = await window.launcherApi.getStatuses({ fresh: test.fresh }); samples.push({ milliseconds: Math.round(performance.now() - before), statuses: statuses.map(({ id, healthState, checkedAt, responseTimeMs }) => ({ id, healthState, checkedAt, responseTimeMs })) }); }
        } else if (test.mode === "renderer") {
          await Promise.all([refreshStatuses({ fresh: false }), ...Array.from({ length: test.count }, () => refreshStatuses({ fresh: true }))]);
          samples.push({ statuses: lastStatuses.map(({ id, healthState, checkedAt, responseTimeMs }) => ({ id, healthState, checkedAt, responseTimeMs })) });
        } else {
          const first = test.mode === "mixed" ? [window.launcherApi.getStatuses({ fresh: false })] : [];
          const all = await Promise.all([...first, ...Array.from({ length: test.count }, () => window.launcherApi.getStatuses({ fresh: test.fresh }))]);
          for (const statuses of all) samples.push({ statuses: statuses.map(({ id, healthState, checkedAt, responseTimeMs }) => ({ id, healthState, checkedAt, responseTimeMs })) });
        }
        return { milliseconds: Math.round(performance.now() - started), samples };
      }, test);
      for (const sample of result.samples) assert.ok(sample.statuses.length === 4 && sample.statuses.every((status) => status.healthState === "healthy"));
      const events = await app.evaluate(() => globalThis.__coreProbeMetrics.events.map(({ phase, kind, label, durationMs }) => ({ phase, kind, label, durationMs })));
      const counts = {}; for (const event of events) counts[`${event.kind}:${event.label}`] = (counts[`${event.kind}:${event.label}`] || 0) + 1;
      if (label.startsWith("after-")) {
        const cycles = test.mode === "sequential" ? 3 : ["mixed", "renderer"].includes(test.mode) ? 2 : 1;
        for (const port of [55432, 3001, 3100, 3002]) assert.equal(counts[`tcp:${port}`], cycles, `${test.name}: no duplicate TCP cycles`);
        assert.equal(counts["process:psql.exe"], cycles, "Every actual cycle keeps a real SQL check");
        assert.equal(counts["process:powershell.exe"] || 0, 0);
        if (test.mode === "renderer") assert.equal(counts["ipc:statuses-fresh"], 1, "Renderer fresh burst must use one IPC request");
        if (test.fresh) for (const port of [3100, 3002]) assert.equal(counts[`fetch:${port}`], test.mode === "sequential" ? 3 : 1, "Manual fresh still reads both actual Next pages");
      }
      cases.push({ name: test.name, requests: test.count + (["mixed", "renderer"].includes(test.mode) ? 1 : 0), milliseconds: result.milliseconds, sequentialMs: result.samples.map((sample) => sample.milliseconds).filter((value) => value !== undefined), counts, events });
      console.log(JSON.stringify({ name: test.name, milliseconds: result.milliseconds, counts }));
    }
    assert.deepEqual(errors, []);
    await app.close(); app = null;
    assert.equal(createHash("sha256").update(await fs.readFile(preferencePath)).digest("hex"), preferencesHash, "Read-only benchmark must not change owner preferences");
    const receipt = { checkedAt: new Date().toISOString(), label, actualElectronIpc: true, instrumentedOriginalMainViaTestEntry: true, readOnly: true, serviceStartStopRun: false, userPreferencesChanged: false, cases, errors };
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ output, label, cases: cases.map(({ name, milliseconds, counts }) => ({ name, milliseconds, counts })) }));
  } finally { if (app) await app.close(); }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
