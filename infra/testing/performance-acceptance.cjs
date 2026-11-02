"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../..");

async function run(args, output, name, extraEnv = {}) {
  const log = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true,
      env: { ...process.env, CORE_TEST_AI: "0", CORE_TEST_MAIL: "0", CORE_TEST_PERFORMANCE: "0", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { text += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      fs.writeFile(path.join(output, name + ".log"), text).then(() => {
        if (code === 0) resolve(text); else reject(Error(`${name} failed; see ${output}`));
      }, reject);
    });
  });
  return log;
}

function receiptFromLog(log) {
  const line = log.trim().split(/\r?\n/).findLast(value => value.startsWith('{"checkedAt"'));
  assert.ok(line, "Missing nested acceptance receipt"); return JSON.parse(line);
}

async function measureLog(file, fresh) {
  const { LogTailReader } = require("../../apps/control-center/dist/log-tail.js");
  const counts = { reads: 0, bytes: 0, inspections: 0 };
  const reader = new LogTailReader(4, async (...args) => {
    const handle = await fs.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (...input) => { const result = await target.read(...input); counts.reads++; counts.bytes += result.bytesRead; return result; };
      if (property === "stat") return async (...input) => { counts.inspections++; return target.stat(...input); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  let expected;
  const start = performance.now();
  for (let poll = 0; poll < 100; poll++) {
    const value = await reader.read(file, undefined, fresh);
    if (poll) assert.equal(value, expected); else expected = value;
  }
  return { ms: performance.now() - start, ...counts };
}

async function benchmark(output) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-performance-"));
  try {
    const file = path.join(directory, "synthetic.log");
    await fs.writeFile(file, "Synthetic log entry\n".repeat(200000));
    const baseline = [], cached = [];
    // Alternate order to reduce warm-file-system bias; timing has no flaky pass/fail threshold.
    for (let round = 0; round < 5; round++) {
      if (round % 2) { cached.push(await measureLog(file, false)); baseline.push(await measureLog(file, true)); }
      else { baseline.push(await measureLog(file, true)); cached.push(await measureLog(file, false)); }
    }
    for (const value of baseline) { assert.equal(value.reads, 100); assert.equal(value.bytes, 100 * 256 * 1024); }
    for (const value of cached) { assert.equal(value.reads, 1); assert.equal(value.bytes, 256 * 1024); assert.equal(value.inspections, 101); }
    const median = values => Number(values.map(item => item.ms).sort((a, b) => a - b)[2].toFixed(2));
    const { readInstallationSnapshot } = require("../../apps/control-center/renderer/workspace-tools.js");
    const delayed = value => new Promise(resolve => setTimeout(() => resolve(value), 30));
    const bridge = { getInstallationPlan: () => delayed("plan"), getInstallationState: () => delayed("state"), getIpPublication: () => delayed("publication") };
    let start = performance.now();
    const sequential = { plan: await bridge.getInstallationPlan(), state: await bridge.getInstallationState(), publication: await bridge.getIpPublication() };
    const sequentialMs = performance.now() - start; start = performance.now();
    assert.deepEqual(await readInstallationSnapshot(bridge, "fixture"), sequential);
    const parallelMs = performance.now() - start;
    const result = { log: { pollsPerRound: 100, rounds: 5, uncachedMedianMs: median(baseline), cachedMedianMs: median(cached),
      uncachedPayloadReadsPerRound: 100, cachedPayloadReadsPerRound: 1, uncachedBytesPerRound: 100 * 256 * 1024, cachedBytesPerRound: 256 * 1024, inspectFileEveryPoll: true },
      installationReads: { fixtureDelayPerGetterMs: 30, sequentialMs: Number(sequentialMs.toFixed(2)), parallelMs: Number(parallelMs.toFixed(2)) },
      scope: "Synthetic local log and delayed mock IPC; not whole-application startup or VPS performance" };
    await fs.writeFile(path.join(output, "benchmark.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("core-performance-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

(async () => {
  const output = path.join(root, "infra/runtime/local-acceptance/performance-20261030", randomUUID());
  await fs.mkdir(output, { recursive: true }); console.log("Performance acceptance: " + output);
  await run(["apps/control-center/node_modules/typescript/bin/tsc", "--project", "apps/control-center/tsconfig.json"], output, "typescript");
  const suites = ["log-tail", "performance", "refresh-queue", "launcher-performance"];
  const tap = await run(["--test", "--test-reporter=tap", ...suites.map(name => `apps/control-center/tests/${name}.test.cjs`)], output, "targeted-tests");
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map(key => [key, Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1])]));
  assert.ok(counts.tests && counts.tests === counts.pass && !counts.fail && !counts.skipped && !counts.cancelled);
  const measurements = await benchmark(output); console.log("Targeted tests and local benchmark accepted");
  await run(["apps/control-center/tests/renderer-smoke.cjs"], output, "renderer-performance", {
    CORE_TEST_OUTPUT: output, CORE_TEST_PERFORMANCE: "1", CORE_TEST_DEPLOYMENT: "0", CORE_TEST_VISUAL: "0", CORE_TEST_SOURCE_LIBRARY: "0", CORE_TEST_STORAGE_FAULT: "0", CORE_TEST_FRAME_LIFECYCLE: "0", CORE_TEST_DRAFT_NAVIGATION: "0"
  });
  console.log("Previous Control Center regression");
  const previous = receiptFromLog(await run(["infra/testing/source-library-acceptance.cjs"], output, "previous-regression"));
  console.log("AI local Linux and renderer regression");
  const ai = receiptFromLog(await run(["infra/testing/ai-configuration-acceptance.cjs"], output, "ai-regression"));
  const receipt = { checkedAt: new Date().toISOString(), counts, previous, ai, totalPassingTests: counts.pass + previous.counts.pass + ai.counts.pass,
    measurements, performanceRenderer: true, externalSshGitProviderRequests: false, output };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ checkedAt: receipt.checkedAt, totalPassingTests: receipt.totalPassingTests, rendererModes: previous.rendererModes + 2, output }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
