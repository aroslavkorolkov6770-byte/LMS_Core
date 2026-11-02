const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { FullUninstallationService } = require("../dist/full-uninstallation.js");
const { NewDeploymentService } = require("../dist/new-deployment.js");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-full-service-")); t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("core-full-service-")); await fs.rm(root, { recursive: true, force: true }); });
  const clientId = crypto.randomUUID(), target = { host: "192.0.2.50", port: 22, username: "root", fingerprint: "SHA256:" + "A".repeat(43), basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/full-fixture" };
  const installed = { id: crypto.randomUUID(), clientId, planId: crypto.randomUUID(), releaseId: crypto.randomUUID(), snapshotId: crypto.randomUUID(), revision: "a".repeat(40), phase: "succeeded", target, webPort: 3000, apiPort: 4101, updatedAt: new Date().toISOString() };
  const control = { archive: null, allowed: true, disconnect: false, partial: false, calls: [], result: null };
  const archive = { accepted: async () => true, get: async () => control.archive,
    prepare: async () => control.archive = { version: 1, preserveData: true, operationId: crypto.randomUUID(), clientId, jobId: installed.id, releaseId: installed.releaseId, target, appPath: target.appPath, webPort: 3000, phase: "checked", checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    execute: async () => { control.calls.push("archive"); return control.archive = { ...control.archive, phase: "uninstalled", backupPath: `/srv/lms-core/backups/${clientId}/${control.archive.operationId}` }; }, refresh: async () => control.archive };
  const remote = { withSession: async (goal, auth, action) => { assert.equal(auth.password, "fixture-only"); return action({ execute: async (cmd, script) => {
    assert.ok(!script.includes("fixture-only")); const match = /removal\.(inspectFullRemoval|completeRemoval)\((\{[^\n]+?\}),\{database/.exec(script);
    if (!match) { control.calls.push("refresh"); return JSON.stringify(control.result); }
    const input = JSON.parse(match[2]), completing = match[1] === "completeRemoval"; control.calls.push(completing ? "complete" : "inspect");
    if (completing && control.disconnect) throw Error("fixture disconnected");
    const result = { ...input, mode: "full", preserveData: false, phase: completing ? control.partial ? "needs_attention" : "uninstalled" : "checked", archiveCompleted: completing || control.archive.phase === "uninstalled", database: "lms_" + clientId.replaceAll("-", ""), databaseDeleted: completing, serviceAccountDeleted: completing && !control.partial, certificatesArchived: completing, ...(completing ? { backupPath: control.archive.backupPath } : {}) }; control.result = result; return JSON.stringify(result);
  } }); } };
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true }); await fs.mkdir(path.join(root, "infra/runtime"), { recursive: true });
  const dependencies = {}; for (const name of ["complete-lms-removal.cjs", "delete-client-database.cjs", "uninstall-lms.cjs", "publish-lms-ip.cjs", "runtime-process.cjs"]) { const bytes = await fs.readFile(path.resolve(__dirname, "../../../infra/scripts", name)); await fs.writeFile(path.join(root, "infra/scripts", name), bytes); dependencies[name] = crypto.createHash("sha256").update(bytes).digest("hex"); }
  await fs.writeFile(path.join(root, "infra/runtime/full-removal-acceptance.json"), JSON.stringify({ version: 2, accepted: true, databaseDeleted: true, serviceAccountDeleted: true, certificatesArchived: true, reinstallReady: true, realReprovisionAndAdmins: true, otherDatabasePreserved: true, backupRestored: true, fixtureCleaned: true, dependencies }));
  const service = new FullUninstallationService(root, remote, { get: async () => installed }, archive, async () => control.allowed);
  const auth = () => ({ mode: "password", password: "fixture-only" });
  return { root, clientId, target, installed, control, service, auth };
}
test("full deletion orders backup before SQL/account cleanup and keeps the client record", async t => {
  const f = await fixture(t), prepared = await f.service.prepare(f.clientId, f.target, f.auth()); assert.equal(prepared.preserveData, false);
  const result = await f.service.execute(f.clientId, prepared.operationId, f.target, f.auth()); assert.equal(result.phase, "uninstalled"); assert.deepEqual(f.control.calls, ["inspect", "archive", "complete"]);
  assert.equal(result.databaseDeleted, true); assert.equal(result.serviceAccountDeleted, true);
});
test("partial completion blocks reinstallation even though archival alone succeeded", async t => {
  const f = await fixture(t), p = await f.service.prepare(f.clientId, f.target, f.auth()); f.control.partial = true;
  assert.equal((await f.service.execute(f.clientId, p.operationId, f.target, f.auth())).phase, "needs_attention");
  await fs.mkdir(path.join(f.root, "infra/runtime/new-deployments")); await fs.writeFile(path.join(f.root, "infra/runtime/new-deployments", f.clientId + ".json"), JSON.stringify(f.installed));
  await fs.mkdir(path.join(f.root, "infra/runtime/uninstallations")); await fs.writeFile(path.join(f.root, "infra/runtime/uninstallations", f.clientId + ".json"), JSON.stringify(f.control.archive));
  const deployments = new NewDeploymentService(f.root, {}, {}, {}, {}); assert.equal((await deployments.get(f.clientId)).phase, "needs_attention");
  f.control.partial = false; const retry = await f.service.prepare(f.clientId, f.target, f.auth()); await f.service.execute(f.clientId, retry.operationId, f.target, f.auth()); assert.equal(await deployments.get(f.clientId), null);
  assert.equal(f.control.calls.filter(value => value === "archive").length, 1);
});
test("disconnection keeps an incomplete state; read-only refresh can confirm completed removal", async t => {
  const f = await fixture(t), p = await f.service.prepare(f.clientId, f.target, f.auth()); f.control.disconnect = true;
  await assert.rejects(f.service.execute(f.clientId, p.operationId, f.target, f.auth())); assert.equal((await f.service.get(f.clientId)).phase, "needs_attention");
  f.control.result = { ...f.control.result, phase: "uninstalled", archiveCompleted: true, databaseDeleted: true, serviceAccountDeleted: true, certificatesArchived: true, backupPath: f.control.archive.backupPath };
  assert.equal((await f.service.refresh(f.clientId, f.target, f.auth())).phase, "uninstalled"); assert.equal(f.control.calls.at(-1), "refresh");
});
test("old archival can be completed without stopping or dumping twice; stale plans and changed workers refuse", async t => {
  const f = await fixture(t); await f.service.prepare(f.clientId, f.target, f.auth()); f.control.archive.phase = "uninstalled"; f.control.archive.backupPath = `/srv/lms-core/backups/${f.clientId}/${f.control.archive.operationId}`;
  const p = await f.service.prepare(f.clientId, f.target, f.auth()); assert.equal(p.archiveCompleted, true);
  await assert.rejects(f.service.execute(f.clientId, crypto.randomUUID(), f.target, f.auth()));
  await fs.appendFile(path.join(f.root, "infra/scripts/complete-lms-removal.cjs"), "\n// fixture\n"); assert.equal(await f.service.accepted(), false); await assert.rejects(f.service.execute(f.clientId, p.operationId, f.target, f.auth()));
  assert.ok(!f.control.calls.includes("archive"));
});
