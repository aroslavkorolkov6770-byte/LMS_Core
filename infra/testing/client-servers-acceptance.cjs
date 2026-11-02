"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
async function acceptance() {
  const output = path.join(root, "infra/runtime/local-acceptance/client-servers-20261031", randomUUID());
  await fs.mkdir(output, { recursive: true });
  console.log("Client server acceptance: " + output);
  const environment = { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules") };
  for (const key of Object.keys(environment)) if (key.startsWith("CORE_TEST_")) delete environment[key];
  async function run(args, name, env = {}, binary = process.execPath) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: root, env: { ...environment, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let text = ""; child.stdout.on("data", data => { text += data; }); child.stderr.on("data", data => { text += data; });
      child.on("error", reject); child.on("exit", code => { void fs.writeFile(path.join(output, name + ".log"), text).then(() => code === 0 ? resolve(text) : reject(Error(name + " failed: " + text.slice(-2500))), reject); });
    });
    console.log(name + " accepted"); return result;
  }
  await run(["apps/control-center/node_modules/typescript/bin/tsc", "--project", "apps/control-center/tsconfig.json"], "typescript");
  const files = ["client-servers", "server-access", "remote-target", "new-installation", "new-deployment", "ip-publication", "deployment-workflow", "uninstallation", "uninstall-worker"];
  const tap = await run(["--test", "--test-reporter=tap", ...files.map(file => `apps/control-center/tests/${file}.test.cjs`)], "unit-regression");
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map(name => [name, Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1])]));
  assert.ok(counts.tests && counts.tests === counts.pass && !counts.fail && !counts.skipped && !counts.cancelled);
  await run(["apps/control-center/tests/client-server-os-store.cjs"], "windows-dpapi");
  const modes = ["NORMAL", "SAVED_SERVERS", "REMOVAL", "FRAME_LIFECYCLE", "DRAFT_NAVIGATION", "AI", "MAIL", "HTTPS"];
  for (const mode of modes) await run(["apps/control-center/tests/renderer-smoke.cjs"], "renderer-" + mode.toLowerCase(), { ["CORE_TEST_" + mode]: "1", CORE_TEST_OUTPUT: output });
  const toLinux = file => "/mnt/" + file[0].toLowerCase() + file.slice(2).replaceAll("\\", "/");
  const linuxTap = await run(["-d", "LMS-Core-Clean-Test", "-u", "root", "--", "node", "--test", "--test-reporter=tap", ...["ai-configuration", "mail-configuration", "uninstall-worker"].map(file => toLinux(path.join(root, `apps/control-center/tests/${file}.test.cjs`)))], "linux-worker-regression", {}, "wsl.exe");
  const linuxCounts = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map(name => [name, Number(linuxTap.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1])]));
  assert.ok(linuxCounts.tests && linuxCounts.tests === linuxCounts.pass && !linuxCounts.fail && !linuxCounts.skipped && !linuxCounts.cancelled);
  const linuxReceipt = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/uninstall-acceptance.json"), "utf8"));
  assert.equal(linuxReceipt.accepted, true); assert.equal(linuxReceipt.realDatabaseDumpAndRestore, true); assert.equal(linuxReceipt.realSystemd, true); assert.equal(linuxReceipt.publicNginxRemoval, true);
  for (const file of ["uninstall-lms.cjs", "publish-lms-ip.cjs", "runtime-process.cjs"]) assert.equal(linuxReceipt.dependencies[file], createHash("sha256").update(await fs.readFile(path.join(root, "infra/scripts", file))).digest("hex"));
  const changed = ["src/client-servers.ts", "src/remote-target.ts", "src/main.ts", "src/preload.ts", "src/new-installation.ts", "src/new-deployment.ts", "src/uninstallation.ts", "renderer/server-access.js", "renderer/renderer.js", "renderer/index.html", "renderer/core-ui.css", "renderer/deployment-workflow.js"];
  const hashes = {};
  for (const file of changed) hashes[file] = createHash("sha256").update(await fs.readFile(path.join(root, "apps/control-center", file))).digest("hex");
  const receipt = { checkedAt: new Date().toISOString(), counts, windowsDpapi: { realElectron: true, separateProcesses: 3, restartedRead: true, forgottenAfterRestart: true }, rendererModes: modes, codeHashes: hashes,
    linuxWorkers: { acceptedInThisRun: true, counts: linuxCounts, realRemovalReceipt: linuxReceipt, duplicateWorkerCases: 12 },
    totalUniquePassingTests: counts.pass + linuxCounts.pass - 12,
    realCoreWindowRestarted: false, realVpsSsh: false, externalMailOrAi: false, allSixTasksComplete: false, output };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
}
void acceptance().catch(error => { console.error(error.message); process.exitCode = 1; });
