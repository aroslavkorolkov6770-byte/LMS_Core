const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../../../infra/scripts/database-preflight.cjs"), "utf8");
function fixture(stdout = "core-db-admin-ok\n", failed = false) {
  const calls = [], module = { exports: {} };
  vm.runInNewContext(source, { module, process: { env: { PATH: "fixture-path" } }, URL, require: name => { assert.equal(name, "node:child_process"); return { execFile: (file, args, options, callback) => { calls.push({ file, args: [...args], env: { ...options.env } }); callback(failed ? Error("private password must not appear") : null, stdout); } }; } });
  return { check: module.exports.checkDatabaseAccess, calls };
}
test("local peer preflight is read-only and requires no SQL password", async () => {
  const f = fixture(), result = await f.check({ databaseMode: "local_peer" }); assert.equal(result.ready, true); assert.equal(f.calls[0].file, "runuser");
  assert.equal(f.calls[0].env.PGPASSWORD, undefined); assert.ok(f.calls[0].args.join(" ").includes("SELECT CASE"));
});
test("manual SQL secret only goes into child environment, not argv or output", async () => {
  const f = fixture(), result = await f.check({ maintenanceUrl: "postgresql://postgres:fixture-secret@127.0.0.1:5432/postgres" });
  assert.equal(result.ready, true); assert.equal(f.calls[0].env.PGPASSWORD, "fixture-secret");
  assert.ok(!f.calls[0].args.join(" ").includes("fixture-secret")); assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});
test("connection and insufficient privilege failures have fixed actionable codes", async () => {
  const f = fixture("", true); assert.equal((await f.check({ databaseMode: "local_peer" })).errorCode, "DATABASE_LOCAL_PEER_UNAVAILABLE");
  assert.equal((await f.check({ maintenanceUrl: "postgresql://root:secret@127.0.0.1/postgres" })).errorCode, "DATABASE_ADMIN_CONNECTION_FAILED");
  assert.equal((await fixture("core-db-admin-denied").check({ databaseMode: "local_peer" })).errorCode, "DATABASE_PROVISION_ADMIN_REQUIRED");
});
