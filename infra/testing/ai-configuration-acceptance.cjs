"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const toLinux = file => "/mnt/" + file[0].toLowerCase() + file.slice(2).replaceAll("\\", "/");
async function run(executable, args, output, name, extraEnv = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve(log) : reject(new Error(`${name} failed:\n${log.slice(-7000)}`)));
  });
  await fs.writeFile(path.join(output, name + ".log"), result); return result;
}
(async () => {
  const output = path.join(root, "infra/runtime/local-acceptance/ai-configuration-20261030", randomUUID()); await fs.mkdir(output, { recursive: true });
  console.log("AI acceptance: " + output);
  await run(process.execPath, ["apps/control-center/node_modules/typescript/bin/tsc", "--project", "apps/control-center/tsconfig.json"], output, "typescript");
  const linux = await run("wsl.exe", ["-d", "LMS-Core-Clean-Test", "-u", "root", "--", "node", "--test", "--test-reporter=tap", toLinux(path.join(root, "apps/control-center/tests/ai-configuration.test.cjs"))], output, "linux-unit");
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map(key => [key, Number(linux.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1])]));
  assert.ok(counts.tests && counts.tests === counts.pass && !counts.fail && !counts.skipped && !counts.cancelled);
  console.log("AI Linux unit tests: " + counts.pass);
  const next = require.resolve("next/package.json", { paths: [path.join(root, "apps/deploy-panel")] });
  const nextEnv = require.resolve("@next/env", { paths: [path.dirname(next)] });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-ai-nextenv-"));
  try {
    await fs.writeFile(path.join(directory, ".env.local"), "AI_API_KEY=older-fixture-token\nUNCHANGED_VAR=kept\n");
    await fs.writeFile(path.join(directory, ".env.production.local"), "AI_API_KEY=current-fixture-token\nAI_PROJECT_ID=fixture-project\n");
    const script = "require(process.argv[1]).loadEnvConfig(process.argv[2],false,{info(){},error(){}},true);if(process.env.AI_API_KEY!=='current-fixture-token'||process.env.UNCHANGED_VAR!=='kept')process.exit(1);console.log('Next production env priority accepted; no token returned');";
    // The real launcher strips inherited AI values; Next then loads the server-only env file.
    const childEnv = require("../scripts/runtime-process.cjs").roleEnvironment({ clientId: "fixture", releaseId: "fixture", apiPort: 4101, webPort: 3000 }, { authSecret: "fixture", serviceToken: "fixture" }, "web");
    const envLog = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script, nextEnv, directory], { env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let log = ""; child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; }); child.once("error", reject); child.once("exit", code => code === 0 ? resolve(log) : reject(Error("Next runtime environment was not loaded")));
    });
    await fs.writeFile(path.join(output, "next-runtime-env.log"), envLog);
    assert.equal(envLog.includes("current-fixture-token"), false);
  } finally { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("core-ai-nextenv-")); await fs.rm(directory, { recursive: true, force: true }); }
  console.log("AI real Linux systemd fixture");
  await run("wsl.exe", ["-d", "LMS-Core-Clean-Test", "-u", "root", "--", "node", toLinux(path.join(root, "infra/testing/ai-linux-acceptance.cjs"))], output, "linux-systemd");
  console.log("AI renderer fixture");
  await run(process.execPath, ["apps/control-center/tests/renderer-smoke.cjs"], output, "renderer-ai", { CORE_TEST_OUTPUT: output, CORE_TEST_AI: "1", CORE_TEST_MAIL: "0", CORE_TEST_PERFORMANCE: "0", CORE_TEST_DEPLOYMENT: "0", CORE_TEST_VISUAL: "0", CORE_TEST_SOURCE_LIBRARY: "0", CORE_TEST_STORAGE_FAULT: "0", CORE_TEST_FRAME_LIFECYCLE: "0", CORE_TEST_DRAFT_NAVIGATION: "0" });
  const receipt = { checkedAt: new Date().toISOString(), counts, nextProductionEnv: true, linuxSystemdFixture: true, uiFixture: true, externalSshOrProviderRequests: false, output };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
