const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const worker = require("../../../infra/scripts/complete-lms-removal.cjs");
const database = require("../../../infra/scripts/delete-client-database.cjs");
const archive = require("../../../infra/scripts/uninstall-lms.cjs");
const publication = require("../../../infra/scripts/publish-lms-ip.cjs");
const vault = require("../../../infra/scripts/runtime-process.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-full-removal-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-full-removal-")); await fs.rm(root, { recursive: true, force: true }); });
  const c = { clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), operationId: crypto.randomUUID(), appPath: "/srv/lms-core/clients/full-fixture", webPort: 3055, host: "127.0.0.1" };
  const backup = `/srv/lms-core/backups/${c.clientId}/${c.operationId}`, disk = file => path.join(root, file), app = disk(backup + "/application");
  await fs.mkdir(path.join(app, "shared"), { recursive: true });
  const owner = { ...c, state: "installed" }, n = database.names(c), key = crypto.randomBytes(32);
  await fs.writeFile(path.join(app, ".core-install-owner.json"), JSON.stringify(owner));
  await fs.writeFile(path.join(app, "shared/runtime-context.json"), JSON.stringify({ clientId: c.clientId, releaseId: c.releaseId, releaseRoot: `${c.appPath}/releases/${c.releaseId}` }));
  await fs.writeFile(path.join(app, "shared/runtime-vault.key"), key);
  await fs.writeFile(path.join(app, "shared/runtime-vault.json"), JSON.stringify(vault.sealSecrets({ databaseUrl: `postgresql://${n.role}:fixture@127.0.0.1:5432/${n.database}` }, key, c.clientId)));
  const dump = Buffer.from("isolated full removal backup"); await fs.writeFile(disk(backup + "/database.dump"), dump);
  await fs.writeFile(disk(backup + "/receipt.json"), JSON.stringify({ ...c, phase: "uninstalled", backupPath: backup, databaseDumpBytes: dump.length, databaseDumpSha256: crypto.createHash("sha256").update(dump).digest("hex") }));
  const user = "lms-" + crypto.createHash("sha256").update(c.clientId).digest("hex").slice(0, 20), state = { account: true, busy: false, shared: false, failDrop: false, dropped: false, calls: [] };
  const options = { root, fixture: true, archived: true, agreement: true, database, archive, publication, unseal: vault.openSecrets,
    executeSql: async sql => { state.calls.push(sql.includes("DROP DATABASE") ? "drop" : "sql-check"); if (state.failDrop && sql.includes("DROP DATABASE")) throw Error("fixture disconnected"); if (sql.includes("DROP DATABASE")) state.dropped = true; return { database: n.database, oid: state.dropped ? null : 123, databaseDeleted: state.dropped, roleDeleted: state.dropped }; },
    run: async (file, args) => {
      if (file === "getent" && args[0] === "passwd") return "root:x:0:0:root:/root:/bin/bash\n" + (state.account ? `${user}:x:501:501::${c.appPath}/shared/home:/usr/sbin/nologin\n` : "") + (state.shared ? "other:x:502:501::/other:/usr/sbin/nologin\n" : "");
      if (file === "getent" && args[0] === "group") { if (!state.account) throw Object.assign(Error(), { exitCode: 2 }); return `${user}:x:501:\n`; }
      if (file === "id") return "501\n";
      if (file === "ps") return state.busy ? "999\n" : "";
      state.calls.push(file); if (file === "userdel") { assert.equal(state.dropped, true); state.account = false; }
      return "";
    } };
  return { c, disk, backup, app, options, state, user };
}
test("full removal requires confirmation and a valid backup before any destructive action", async t => {
  const f = await fixture(t); await assert.rejects(worker.completeRemoval(f.c, { ...f.options, agreement: false }), /CONFIRMATION/);
  await fs.appendFile(f.disk(f.backup + "/database.dump"), "modified"); await assert.rejects(worker.completeRemoval(f.c, f.options), /BACKUP_INVALID/); assert.deepEqual(f.state.calls, []);
});
test("database is dropped before the own account; archive and retry remain usable", async t => {
  const f = await fixture(t); assert.equal((await worker.inspectFullRemoval(f.c, f.options)).phase, "checked");
  const result = await worker.completeRemoval(f.c, f.options);
  assert.equal(result.phase, "uninstalled"); assert.equal(result.preserveData, false); assert.equal(result.databaseDeleted, true); assert.equal(result.serviceAccountDeleted, true);
  assert.ok(f.state.calls.indexOf("drop") < f.state.calls.indexOf("userdel")); assert.ok(f.state.calls.indexOf("chown") < f.state.calls.indexOf("userdel"));
  assert.ok((await fs.stat(f.app)).isDirectory()); assert.equal((await worker.completeRemoval(f.c, f.options)).phase, "uninstalled");
});
test("foreign marker, shared or busy Linux identity cannot trigger SQL deletion", async t => {
  const f = await fixture(t); f.state.shared = true; await assert.rejects(worker.inspectFullRemoval(f.c, f.options), /ACCOUNT/); assert.equal((await worker.completeRemoval(f.c, f.options)).phase, "needs_attention"); assert.ok(!f.state.calls.includes("drop"));
  f.state.shared = false; f.state.busy = true; const result = await worker.completeRemoval(f.c, f.options); assert.equal(result.phase, "needs_attention"); assert.equal(f.state.account, true); assert.ok(!f.state.calls.includes("drop"));
});
test("SQL failure preserves account, records incomplete outcome and a checked retry succeeds", async t => {
  const f = await fixture(t); f.state.failDrop = true; const failed = await worker.completeRemoval(f.c, f.options);
  assert.equal(failed.phase, "needs_attention"); assert.equal(f.state.account, true); assert.ok(!f.state.calls.includes("userdel"));
  f.state.failDrop = false; assert.equal((await worker.inspectFullRemoval(f.c, f.options)).phase, "checked"); assert.equal((await worker.completeRemoval(f.c, f.options)).phase, "uninstalled");
});
test("only owned certificate resources are archived; active app path blocks cleanup", async t => {
  const f = await fixture(t), tls = publication.tlsPaths(f.c), renewal = publication.renewalConfiguration(f.c);
  await fs.mkdir(f.disk(tls.base), { recursive: true }); await fs.writeFile(f.disk(tls.base + "/reload-nginx.sh"), renewal.files.find(([name]) => name === tls.base + "/reload-nginx.sh")[1]);
  await fs.mkdir(f.disk(tls.webroot), { recursive: true }); await fs.writeFile(f.disk(tls.webroot + "/fixture.txt"), "owned fixture");
  await fs.mkdir(f.disk(f.c.appPath), { recursive: true }); await assert.rejects(worker.completeRemoval(f.c, f.options), /INSTALLATION_PRESENT/); await fs.rmdir(f.disk(f.c.appPath));
  const result = await worker.completeRemoval(f.c, f.options); assert.equal(result.certificatesArchived, true);
  await assert.rejects(fs.stat(f.disk(tls.base))); assert.equal(await fs.readFile(f.disk(f.backup + "/acme-webroot/fixture.txt"), "utf8"), "owned fixture");
});
