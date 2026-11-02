const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { ClientDeletionService } = require("../dist/client-deletion.js");
async function fixture(t, installed = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-client-deletion-"));
  t.after(async () => { assert.ok(path.basename(root).startsWith("core-client-deletion-")); await fs.rm(root, { recursive: true }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  for (const file of ["delete-client-database.cjs", "runtime-process.cjs"]) await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts", file), path.join(root, "infra/scripts", file));
  const clientId = crypto.randomUUID(), calls = [], state = { removal: null, failRemote: false, finalizeFail: false, allowed: true, accepted: true, status: "draft" };
  const target = { host: "fixture.invalid", port: 22, username: "root", fingerprint: "SHA256:" + "A".repeat(43), basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/fixture" };
  const record = { id: crypto.randomUUID(), releaseId: crypto.randomUUID(), clientId, target, phase: "succeeded", webPort: 3000 };
  const removal = {
    get: async () => state.removal, accepted: async () => state.accepted,
    prepare: async (id, goal, auth) => { calls.push("backup-check"); delete auth.password; return state.removal = { operationId: crypto.randomUUID(), clientId, jobId: record.id, releaseId: record.releaseId, target, appPath: target.appPath, phase: "checked" }; },
    execute: async (id, op, goal, auth) => { calls.push("backup"); assert.equal(auth.password, "fixture-secret"); delete auth.password; return state.removal = { ...state.removal, phase: "uninstalled" }; }
  };
  const remote = { withSession: async (goal, auth, action) => { assert.equal(auth.password, "fixture-secret"); return action({ execute: async (command, script) => {
    const drop = script.includes("worker.deleteArchivedDatabase("); calls.push(drop ? "drop" : "database-check");
    if (state.failRemote && drop) throw Error("SSH disconnected");
    return JSON.stringify({ database: "lms_" + clientId.replaceAll("-", ""), databaseDeleted: drop, backupPath: "fixture-backup" });
  } }); } };
  const service = new ClientDeletionService(root, remote, { get: async () => installed ? record : null }, removal, async () => "unused", { available: () => true, encrypt: () => Buffer.from("protected") }, async () => state.allowed);
  service.core = async work => work({ unsafe: async () => [{ status: state.status }] });
  service.store = () => ({ clientSnapshot: async () => ({ client: { id: clientId, name: "Fixture" }, hash: "a".repeat(64) }),
    finalizeClientDeletion: async () => { calls.push("card"); if (state.finalizeFail) throw Error("local transaction failed"); return { clientId, operationId: crypto.randomUUID(), phase: "deleted" }; } });
  service.accepted = async () => state.accepted;
  return { root, clientId, calls, state, record, service };
}
test("cancel means no SSH, no backup, no database or card deletion", async t => {
  const f = await fixture(t); assert.equal((await f.service.execute(f.clientId, { mode: "password", password: "fixture-secret" }, async () => false, () => {})).phase, "cancelled"); assert.deepEqual(f.calls, []);
});
test("installed deletion requires fresh gate/policy and backups before database, card last", async t => {
  const f = await fixture(t); const auth = { mode: "password", password: "fixture-secret" };
  assert.equal((await f.service.execute(f.clientId, auth, async () => true, () => {})).phase, "deleted");
  assert.deepEqual(f.calls, ["database-check", "backup-check", "backup", "drop", "card"]); assert.equal(auth.password, undefined);
});
test("draft deletion does not contact any server", async t => {
  const f = await fixture(t, false); assert.equal((await f.service.plan(f.clientId)).database, null);
  await f.service.execute(f.clientId, null, async () => true, () => {}); assert.deepEqual(f.calls, ["card"]);
});
test("deployed card without trusted installation cannot be treated as draft", async t => {
  const f = await fixture(t, false); f.state.status = "deployed"; await assert.rejects(f.service.plan(f.clientId), /учета установки нет/); assert.deepEqual(f.calls, []);
});
test("unreadable installation record blocks fallback to draft", async t => {
  const f = await fixture(t, false); await fs.mkdir(path.join(f.root, "infra/runtime/new-deployments"), { recursive: true });
  await fs.writeFile(path.join(f.root, "infra/runtime/new-deployments", f.clientId + ".json"), "corrupt"); await assert.rejects(f.service.plan(f.clientId), /нечитаемая установка/);
});
test("disconnect never removes card; retry reuses archived installation", async t => {
  const f = await fixture(t); f.state.failRemote = true;
  await assert.rejects(f.service.execute(f.clientId, { mode: "password", password: "fixture-secret" }, async () => true, () => {}), /disconnected/);
  assert.ok(!f.calls.includes("card")); assert.equal(f.state.removal.phase, "uninstalled");
  f.state.failRemote = false; f.calls.length = 0;
  await f.service.execute(f.clientId, { mode: "password", password: "fixture-secret" }, async () => true, () => {}); assert.deepEqual(f.calls, ["drop", "card"]);
});
test("failed local transaction leaves removal receipt usable for retry", async t => {
  const f = await fixture(t); f.state.finalizeFail = true;
  await assert.rejects(f.service.execute(f.clientId, { mode: "password", password: "fixture-secret" }, async () => true, () => {}), /local transaction failed/);
  f.state.finalizeFail = false; f.calls.length = 0;
  await f.service.execute(f.clientId, { mode: "password", password: "fixture-secret" }, async () => true, () => {}); assert.deepEqual(f.calls, ["drop", "card"]);
});
test("gate and external execution policy block all mutation", async t => {
  const f = await fixture(t); f.state.accepted = false;
  await assert.rejects(f.service.execute(f.clientId, null, async () => true, () => {}), /Linux/);
  f.state.accepted = true; f.state.allowed = false; await assert.rejects(f.service.plan(f.clientId), /Внешние операции/); assert.deepEqual(f.calls, []);
});
