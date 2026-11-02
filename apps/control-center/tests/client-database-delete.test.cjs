const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const worker = require("../../../infra/scripts/delete-client-database.cjs");
const vault = require("../../../infra/scripts/runtime-process.cjs");
const input = () => ({ clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), operationId: crypto.randomUUID(), appPath: "/srv/lms-core/clients/delete-fixture" });

test("database identity only comes from UUID, rejects paths and injection", () => {
  const c = input(), n = worker.names(c);
  assert.equal(n.database, "lms_" + c.clientId.replaceAll("-", ""));
  for (const patch of [{ clientId: "lms_core" }, { jobId: "'; DROP DATABASE postgres;" }, { appPath: "/srv/lms-core/clients/../other" }]) assert.throws(() => worker.names({ ...c, ...patch }));
  assert.throws(() => worker.databaseSql(c, true, "1;DROP"));
});
test("DROP uses a maintenance session lock, owner/marker/OID guards and no CASCADE", () => {
  const sql = worker.databaseSql(input(), true, 123);
  assert.ok(sql.indexOf("pg_advisory_lock") < sql.indexOf("DROP DATABASE"));
  for (const text of ["datdba<>r.oid", "pg_database", "pg_authid", "d.oid<>123", "ALLOW_CONNECTIONS false", "pg_terminate_backend", "DROP ROLE", "current_database()<>'postgres'"]) assert.ok(sql.includes(text), text);
  assert.ok(!sql.includes("CASCADE"));
  assert.ok(!worker.databaseSql(input()).includes("DROP DATABASE"));
});
async function fixture(t, archived = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-delete-worker-"));
  t.after(async () => { assert.ok(path.basename(root).startsWith("core-delete-worker-")); await fs.rm(root, { recursive: true }); });
  const c = input(), backup = `/srv/lms-core/backups/${c.clientId}/${c.operationId}`;
  const disk = p => path.join(root, p), base = disk(archived ? backup + "/application" : c.appPath);
  await fs.mkdir(path.join(base, "shared"), { recursive: true });
  const key = crypto.randomBytes(32), n = worker.names(c);
  await fs.writeFile(path.join(base, ".core-install-owner.json"), JSON.stringify({ ...c, state: "installed" }));
  await fs.writeFile(path.join(base, "shared/runtime-context.json"), JSON.stringify({ ...c, releaseRoot: `${c.appPath}/releases/${c.releaseId}` }));
  await fs.writeFile(path.join(base, "shared/runtime-vault.key"), key);
  await fs.writeFile(path.join(base, "shared/runtime-vault.json"), JSON.stringify(vault.sealSecrets({ databaseUrl: `postgresql://${n.role}:secret@127.0.0.1:5432/${n.database}` }, key, c.clientId)));
  if (archived) {
    const dump = Buffer.from("isolated backup fixture");
    await fs.writeFile(disk(backup + "/database.dump"), dump);
    await fs.writeFile(disk(backup + "/receipt.json"), JSON.stringify({ ...c, backupPath: backup, phase: "uninstalled", databaseDumpBytes: dump.length, databaseDumpSha256: crypto.createHash("sha256").update(dump).digest("hex") }));
  }
  const calls = [];
  const options = { root, fixture: true, agreement: true, unseal: vault.openSecrets, executeSql: async sql => {
    calls.push(sql); return { database: n.database, oid: sql.includes("DROP DATABASE") ? null : 123, databaseDeleted: sql.includes("DROP DATABASE"), roleDeleted: sql.includes("DROP DATABASE") };
  } };
  return { c, base, backup, disk, options, calls, key };
}
test("active preflight is read only", async t => { const f = await fixture(t, false); assert.equal((await worker.checkClientDatabase(f.c, f.options)).phase, "checked"); assert.equal(f.calls.length, 1); assert.ok(!f.calls[0].includes("DROP")); });
test("archive, backup and explicit confirmation required before DROP", async t => {
  const f = await fixture(t);
  await assert.rejects(worker.deleteArchivedDatabase(f.c, { ...f.options, agreement: false }), /CONFIRMATION_REQUIRED/);
  await fs.appendFile(f.disk(f.backup + "/database.dump"), "changed");
  await assert.rejects(worker.deleteArchivedDatabase(f.c, f.options), /BACKUP_INVALID/); assert.equal(f.calls.length, 0);
});
test("foreign owner rejected", async t => {
  const f = await fixture(t); const file = path.join(f.base, ".core-install-owner.json");
  const owner = JSON.parse(await fs.readFile(file)); owner.clientId = crypto.randomUUID(); await fs.writeFile(file, JSON.stringify(owner));
  await assert.rejects(worker.deleteArchivedDatabase(f.c, f.options), /OWNER_MISMATCH/); assert.equal(f.calls.length, 0);
});
test("separate database server fails closed", async t => {
  const f = await fixture(t), n = worker.names(f.c);
  await fs.writeFile(path.join(f.base, "shared/runtime-vault.json"), JSON.stringify(vault.sealSecrets({ databaseUrl: `postgresql://${n.role}:secret@192.0.2.10/${n.database}` }, f.key, f.c.clientId)));
  await assert.rejects(worker.deleteArchivedDatabase(f.c, f.options), /SEPARATE_DATABASE_UNSUPPORTED/); assert.equal(f.calls.length, 0);
});
test("own original app still present blocks DB destruction", async t => {
  const f = await fixture(t); await fs.mkdir(f.disk(f.c.appPath), { recursive: true });
  await assert.rejects(worker.deleteArchivedDatabase(f.c, f.options), /STILL_PRESENT/); assert.equal(f.calls.length, 0);
});
test("success and retry reuse validated OID journal; no secret in receipt", async t => {
  const f = await fixture(t); const first = await worker.deleteArchivedDatabase(f.c, f.options);
  assert.equal(first.databaseDeleted, true); assert.equal(first.databaseOid, 123); assert.ok(!JSON.stringify(first).includes("secret"));
  f.calls.length = 0; assert.equal((await worker.deleteArchivedDatabase(f.c, f.options)).phase, "database_deleted");
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].includes("d.oid<>123"));
});
test("unknown SSH/SQL outcome leaves retry journal and propagates failure", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(worker.deleteArchivedDatabase(f.c, { ...f.options, executeSql: async sql => { if (++calls === 1) return f.options.executeSql(sql); throw Error("disconnect"); } }), /disconnect/);
  assert.equal(JSON.parse(await fs.readFile(f.disk(f.backup + "/client-deletion.json"))).phase, "deleting");
});
