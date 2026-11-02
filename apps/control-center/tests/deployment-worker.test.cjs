const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { executeUpdate, validateConfig, snapshotTree, UpdateError } = require("../../../infra/scripts/lms-update-worker.cjs");

function fixture(failure) {
  const calls = [];
  const driver = {};
  for (const name of ["validate", "build", "stop", "backup", "switch", "start", "health", "commit"]) {
    driver[name] = async () => { calls.push(name); if (failure === name) throw new UpdateError(`FAIL_${name.toUpperCase()}`); };
  }
  driver.rollback = async (switched) => { calls.push(`rollback:${switched}`); };
  return { driver, calls };
}

test("successful update strictly orders build before stopping and backup before code switch", async () => {
  const { driver, calls } = fixture();
  const phases = [];
  const result = await executeUpdate(driver, (phase) => phases.push(phase));
  assert.equal(result.phase, "succeeded");
  assert.deepEqual(calls, ["validate", "build", "stop", "backup", "switch", "start", "health", "commit"]);
  assert.equal(phases.at(-1), "succeeded");
});

for (const phase of ["validate", "build"]) test(`${phase} failure never stops, switches or restarts the live site`, async () => {
  const { driver, calls } = fixture(phase);
  const result = await executeUpdate(driver, () => {});
  assert.equal(result.phase, "failed");
  assert.equal(calls.includes("stop"), false);
  assert.equal(calls.some((item) => item.startsWith("rollback")), false);
});

for (const phase of ["stop", "backup", "switch", "start", "health", "commit"]) test(`${phase} failure invokes rollback and is never reported as successful deployment`, async () => {
  const { driver, calls } = fixture(phase);
  const result = await executeUpdate(driver, () => {});
  assert.equal(result.phase, "rolled_back");
  assert.equal(result.errorCode, `FAIL_${phase.toUpperCase()}`);
  assert.equal(calls.at(-1), `rollback:${["switch", "start", "health", "commit"].includes(phase)}`);
  if (phase === "backup") assert.equal(calls.includes("switch"), false);
});

test("failed rollback requires attention instead of a false recovered status", async () => {
  const { driver } = fixture("health");
  driver.rollback = async () => { throw new Error("fixture-private-secret"); };
  const result = await executeUpdate(driver, () => {});
  assert.equal(result.phase, "needs_attention");
  assert.equal(result.errorCode, "ROLLBACK_FAILED");
  assert.ok(!JSON.stringify(result).includes("fixture-private-secret"));
});

test("unknown build errors are sanitized", async () => {
  const { driver } = fixture();
  driver.build = async () => { throw new Error("fixture-private-secret"); };
  assert.equal((await executeUpdate(driver, () => {})).errorCode, "UPDATE_FAILED");
});

test("status write failure cannot prevent rollback", async () => {
  const { driver, calls } = fixture("health");
  const result = await executeUpdate(driver, () => { throw new Error("fixture disk full"); });
  assert.equal(result.phase, "rolled_back");
  assert.equal(calls.at(-1), "rollback:true");
});

test("worker config rejects traversal, shell input and missing explicit memory policy", () => {
  const config = { id: "f0140c68-d136-4fe2-aa40-80d9ae2e5185", appPath: "/var/www/lms", basePath: "/srv/lms-core/clients", revision: "a".repeat(40), sha256: "b".repeat(64), allowSwap: true };
  assert.deepEqual(validateConfig(config), config);
  for (const change of [{ appPath: "/" }, { appPath: "/var/www/../etc" }, { appPath: "/var/www/lms;id" }, { id: "../../other" }, { allowSwap: undefined }, { revision: "HEAD" }]) {
    assert.throws(() => validateConfig({ ...config, ...change }));
  }
});

test("data fingerprints detect changed content, filenames and empty directories without leaking content", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-backup-hash-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("core-backup-hash-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "users.json"), "fixture-private-secret");
  const first = snapshotTree(root);
  assert.match(first, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(root, "users.json"), "updated fixture");
  assert.notEqual(snapshotTree(root), first);
  const second = snapshotTree(root);
  fs.mkdirSync(path.join(root, "empty"));
  assert.notEqual(snapshotTree(root), second);
});
