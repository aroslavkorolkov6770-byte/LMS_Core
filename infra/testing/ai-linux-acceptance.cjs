"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const exec = require("node:util").promisify(require("node:child_process").execFile);
const assert = require("node:assert/strict");
const { configureAi, inspectAi } = require("../scripts/configure-lms-ai.cjs");
const { sealSecrets } = require("../scripts/runtime-process.cjs");

async function runFixture(extension) {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const base = "/opt/lms-core-ai-fixtures";
  await fs.mkdir(base, { recursive: true, mode: 0o755 });
  const parent = await fs.lstat(base); assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && !(parent.mode & 0o022));
  const root = await fs.mkdtemp(base + "/ai-"), clientId = crypto.randomUUID(), jobId = crypto.randomUUID(), releaseId = crypto.randomUUID();
  const slug = "ai-test-" + crypto.randomUUID().slice(0, 8), appPath = path.join(root, "clients", slug), release = path.join(appPath, "releases", releaseId), app = path.join(release, "lms"), shared = path.join(appPath, "shared");
  const user = "lms-" + crypto.createHash("sha256").update(clientId).digest("hex").slice(0, 20), unit = `lms-${slug}-web.service`, unitFile = `/etc/systemd/system/${unit}`;
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve)); const webPort = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const c = { clientId, jobId, releaseId, appPath, webPort }, calls = [];
  let userCreated = false, unitCreated = false;
  const run = async (file, args) => { calls.push([file, ...args]); return (await exec(file, args, { timeout: 45000, maxBuffer: 65536 })).stdout; };
  try {
    await run("systemctl", ["show", "--property=Version", "--value"]);
    await run("useradd", ["--system", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", user]); userCreated = true;
    await fs.mkdir(path.join(app, "app/lib"), { recursive: true, mode: 0o750 }); await fs.mkdir(path.join(app, "node_modules/next/dist/bin"), { recursive: true });
    await fs.mkdir(path.join(release, "backend")); await fs.mkdir(shared, { mode: 0o750 });
    // This fixture uses the real launcher contract but no LMS data or database.
    const contextFile = path.join(shared, "runtime-context.json"), context = { clientId, releaseId, releaseRoot: release, webPort, apiPort: webPort + 1 };
    const key = crypto.randomBytes(32), secrets = { databaseUrl: "unused-in-web-fixture", serviceToken: "unused-fixture-service", authSecret: "unused-fixture-auth", encryptionKey: "unused-fixture-key" };
    await fs.writeFile(contextFile, JSON.stringify(context), { mode: 0o640 });
    await fs.writeFile(path.join(shared, "runtime-vault.key"), key, { mode: 0o640 }); await fs.writeFile(path.join(shared, "runtime-vault.json"), JSON.stringify(sealSecrets(secrets, key, clientId)), { mode: 0o640 });
    await fs.writeFile(path.join(appPath, ".core-install-owner.json"), JSON.stringify({ clientId, jobId, releaseId, state: "installed", services: [unit] }), { mode: 0o600 });
    await fs.symlink(release, path.join(appPath, "current"));
    await fs.writeFile(path.join(app, "app/lib/aliceAi.ts"), "getAliceAiConfig AI_API_KEY AI_PROJECT_ID AI_PROMPT_ID AI_VECTOR_STORE_ID", { mode: 0o644 });
    await fs.writeFile(path.join(app, ".env.production.local"), "CORE_AI_UNRELATED=must-survive\n", { mode: 0o600 });
    await fs.copyFile(path.join(__dirname, "fixtures/ai-web.cjs"), path.join(app, "node_modules/next/dist/bin/next"));
    // Fixture context is nonsecret and copied next to its server because the launcher strips extra environment.
    let launcher = await fs.readFile(path.join(__dirname, "../scripts/runtime-process.cjs"), "utf8");
    assert.ok(launcher.includes('env: roleEnvironment(context, secrets, role)'));
    launcher = launcher.replace('env: roleEnvironment(context, secrets, role)', 'env: { ...roleEnvironment(context, secrets, role), CORE_AI_FIXTURE_CONTEXT: contextFile }');
    await fs.writeFile(path.join(release, "backend/runtime-process.cjs"), launcher, { mode: 0o644 });
    await run("chmod", ["755", root, path.join(root, "clients")]); await run("chgrp", ["-R", user, appPath]); await run("chown", ["-R", `${user}:${user}`, app]);
    // A composed fixture deliberately performs many healthy restarts in seconds; production limits stay unchanged.
    await fs.writeFile(unitFile, `# LMS Core AI fixture ${clientId}\n[Unit]\nDescription=Isolated Core AI test\n${extension ? "StartLimitIntervalSec=0\n" : ""}[Service]\nUser=${user}\nGroup=${user}\nWorkingDirectory=${release}\nExecStart=${process.execPath} ${release}/backend/runtime-process.cjs ${contextFile} web\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n`, { flag: "wx", mode: 0o644 }); unitCreated = true;
    await run("systemctl", ["daemon-reload"]); await run("systemctl", ["start", unit]);
    const probe = async () => (await fetch(`http://127.0.0.1:${webPort}/fixture/check`, { signal: AbortSignal.timeout(2000) })).json();
    for (let attempt = 0; ; attempt++) { try { await probe(); break; } catch { if (attempt > 30) throw Error("Fixture service not ready"); await new Promise(resolve => setTimeout(resolve, 300)); } }
    const ids = { AI_PROJECT_ID: "fixture-project", AI_PROMPT_ID: "fixture-prompt", AI_VECTOR_STORE_ID: "fixture-vector" };
    const first = await configureAi({ ...c, operationId: crypto.randomUUID() }, { ...ids, AI_API_KEY: "fixture-ai-v1" }, { run });
    assert.equal(first.phase, "applied", JSON.stringify(first)); assert.deepEqual(await probe(), { tokenVersion: 1, unrelatedPreserved: true });
    const stat = await fs.stat(path.join(shared, "ai.env")); assert.equal(stat.mode & 0o777, 0o640); assert.equal(stat.uid, 0); assert.equal(stat.gid, Number((await run("id", ["-g", user])).trim()));
    const second = await configureAi({ ...c, operationId: crypto.randomUUID() }, { ...ids, AI_API_KEY: "fixture-ai-v2" }, { run });
    assert.equal(second.phase, "applied"); assert.deepEqual(await probe(), { tokenVersion: 2, unrelatedPreserved: true });
    const read = await inspectAi(c, { run }); assert.equal(read.apiKeyPresent, true); assert.equal(JSON.stringify(read).includes("fixture-ai-v2"), false);
    const rollback = await configureAi({ ...c, operationId: crypto.randomUUID() }, { ...ids, AI_API_KEY: "fixture-ai-v3" }, { run, attempts: 2, delayMs: 50,
      fetch: async (url, init) => { const response = await fetch(url, init); const state = await probe(); return state.tokenVersion === 3 ? { ok: false, json: () => response.json() } : response; } });
    assert.equal(rollback.phase, "failed"); assert.equal(rollback.rollbackRestored, true); assert.deepEqual(await probe(), { tokenVersion: 2, unrelatedPreserved: true });
    assert.ok(calls.filter(call => call[0] === "systemctl" && call[1] === "restart").every(call => call[2] === unit));
    if (extension) await extension({ c, run, probe, root, app, shared, user, unit, ids });
    console.log(JSON.stringify({ linuxSystemd: true, nodeMajor: Number(process.versions.node.split(".")[0]), firstWrite: true, rotation: true, oldVariablesPreserved: true, rootGroup640: true, onlyWebRestarted: true, rollback: true, tokenNotReturned: true, providerRequests: 0 }));
  } finally {
    if (unitCreated) { await exec("systemctl", ["stop", unit], { timeout: 45000 }).catch(() => {}); const body = await fs.readFile(unitFile, "utf8"); assert.ok(body.startsWith(`# LMS Core AI fixture ${clientId}\n`)); await fs.unlink(unitFile); await exec("systemctl", ["daemon-reload"]); }
    if (userCreated) await exec("userdel", [user]);
    const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), base); assert.ok(path.basename(resolved).startsWith("ai-")); await fs.rm(resolved, { recursive: true, force: true });
  }
}

module.exports = { runFixture };
if (require.main === module) runFixture().catch(error => { console.error(error.stack || error.code || error.message); process.exitCode = 1; });
