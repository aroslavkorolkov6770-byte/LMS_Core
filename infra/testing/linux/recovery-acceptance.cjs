"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const root = path.resolve(__dirname, "../../.."), worker = require(path.join(root, "infra/scripts/recover-failed-installation.cjs"));
const run = async (file, args) => (await promisify(execFile)(file, args, { timeout: 30000 })).stdout;
async function acceptance() {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const input = { clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), appPath: "/srv/lms-core/clients/recovery-fixture-" + crypto.randomUUID().slice(0, 12) }, c = worker.validate(input);
  const jobPath = `/srv/lms-core/jobs/${input.jobId}`; let account = false, application = false, job = false;
  try {
    await fs.mkdir("/srv/lms-core/clients", { recursive: true }); await fs.mkdir("/srv/lms-core/jobs", { recursive: true });
    for (const parent of ["/srv/lms-core/clients", "/srv/lms-core/jobs"]) { const s = await fs.lstat(parent); assert.equal(s.isSymbolicLink(), false); assert.equal(s.uid, 0); }
    await run("useradd", ["--system", "--user-group", "--home-dir", input.appPath + "/shared/home", "--shell", "/usr/sbin/nologin", c.user]); account = true;
    await fs.mkdir(input.appPath, { mode: 0o750 }); application = true;
    await run("chgrp", [c.user, input.appPath]);
    await fs.writeFile(input.appPath + "/.core-install-owner.json", JSON.stringify({ ...input, state: "installing" }), { mode: 0o600 });
    await fs.mkdir(jobPath, { mode: 0o700 }); job = true;
    await fs.writeFile(jobPath + "/status.json", JSON.stringify({ id: input.jobId, clientId: input.clientId, releaseId: input.releaseId, phase: "needs_attention", failedStep: "initialize", errorCode: "DATABASE_PROVISION_UNCONFIRMED" }), { mode: 0o600 });
    assert.equal((await worker.inspectRecovery(input)).phase, "retry_available");
    const result = await worker.recoverFailedInstallation(input, { agreement: true });
    assert.equal(result.phase, "retry_available");
    await assert.rejects(fs.stat(input.appPath)); await assert.rejects(run("getent", ["passwd", c.user])); account = false;
    assert.equal(JSON.parse(await fs.readFile(jobPath + "/status.json")).phase, "failed");
    assert.ok(await fs.stat(c.archive + "/application/.core-install-owner.json"));
    console.log("real Linux recovery: own reservation archived, unused service account removed, no database deletion");
  } finally {
    if (account) await run("userdel", [c.user]);
    for (const directory of [input.appPath, c.archive + "/application"]) {
      try { const owner = JSON.parse(await fs.readFile(directory + "/.core-install-owner.json")); assert.equal(owner.clientId, input.clientId); assert.equal(owner.jobId, input.jobId); assert.ok(directory === input.appPath || directory === c.archive + "/application"); await fs.rm(directory, { recursive: true }); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    try { const receipt = JSON.parse(await fs.readFile(c.archive + "/receipt.json")); assert.equal(receipt.jobId, input.jobId); await fs.unlink(c.archive + "/receipt.json"); await fs.rmdir(c.archive); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (job) { const status = JSON.parse(await fs.readFile(jobPath + "/status.json")); assert.equal(status.id, input.jobId); assert.equal(path.dirname(jobPath), "/srv/lms-core/jobs"); await fs.rm(jobPath, { recursive: true }); }
  }
  const receipt = { version: 1, accepted: true, realLinuxAccount: true, databaseUntouched: true, ownArchive: true, fixtureCleaned: true, checkedAt: new Date().toISOString(), workerSha256: crypto.createHash("sha256").update(await fs.readFile(path.join(root, "infra/scripts/recover-failed-installation.cjs"))).digest("hex") };
  await fs.writeFile(path.join(root, "infra/runtime/recovery-acceptance.json"), JSON.stringify(receipt)); console.log(JSON.stringify(receipt));
}
void acceptance().catch(e => { console.error(e.message); process.exitCode = 1; });
