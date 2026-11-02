const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { UninstallationService } = require("../dist/uninstallation.js");
const { NewDeploymentService } = require("../dist/new-deployment.js");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-uninstallation-service-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-uninstallation-service-")); await fs.rm(root, { recursive: true, force: true }); });
  const clientId = crypto.randomUUID(), target = { host: "198.51.100.25", port: 22, username: "root", basePath: "/srv/lms-core/clients", fingerprint: "SHA256:" + "a".repeat(43), appPath: "/srv/lms-core/clients/service-fixture" };
  const installed = { id: crypto.randomUUID(), clientId, planId: crypto.randomUUID(), releaseId: crypto.randomUUID(), snapshotId: crypto.randomUUID(), revision: "a".repeat(40), target, phase: "succeeded", updatedAt: new Date().toISOString(), webPort: 3000, apiPort: 4101 };
  const dependencies = {};
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  for (const name of ["uninstall-lms.cjs", "publish-lms-ip.cjs", "runtime-process.cjs"]) {
    const bytes = await fs.readFile(path.join(__dirname, "../../../infra/scripts", name));
    await fs.writeFile(path.join(root, "infra/scripts", name), bytes); dependencies[name] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  await fs.mkdir(path.join(root, "infra/runtime"), { recursive: true });
  const receipt = path.join(root, "infra/runtime/uninstall-acceptance.json");
  await fs.writeFile(receipt, JSON.stringify({ version: 1, accepted: true, realSystemd: true, realDatabaseDumpAndRestore: true, publicNginxRemoval: true, fixtureCleaned: true, dependencies }));
  const calls = [], control = { disconnected: false, allowed: true, result: null };
  const remote = { withSession: async (selected, auth, operation) => {
    assert.equal(selected.host, target.host); assert.equal(auth.password, "fixture-ssh-password");
    return operation({ execute: async (command, script) => {
      assert.equal(command, "node -"); assert.equal(typeof script, "string"); assert.ok(!script.includes("fixture-ssh-password")); calls.push(script);
      if (control.disconnected) throw Error("fixture transport disconnected");
      const match = /removal\.(inspectRemoval|uninstallLms)\((\{[^\n]+?\}),\{publication/.exec(script);
      if (!match) return JSON.stringify(control.result);
      const payload = JSON.parse(match[2]);
      const result = { ...payload, phase: match[1] === "inspectRemoval" ? "checked" : "uninstalled", preserveData: true, extraSecret: "must-not-persist" };
      if (result.phase === "uninstalled") result.backupPath = `/srv/lms-core/backups/${clientId}/${payload.operationId}`;
      control.result = result; return JSON.stringify(result);
    } });
  } };
  const service = new UninstallationService(root, remote, { get: async id => id === clientId ? installed : null }, async () => control.allowed);
  const auth = () => ({ mode: "password", password: "fixture-ssh-password" });
  return { root, service, installed, clientId, target, calls, control, receipt, auth };
}
test("uninstall service requires exact installation, pinned target and execution policy", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepare(f.clientId, { ...f.target, host: "different.invalid" }, f.auth()));
  f.control.allowed = false; await assert.rejects(f.service.prepare(f.clientId, f.target, f.auth()));
  assert.equal(f.calls.length, 0);
});
test("read-only preparation and execution save only public identity and data-preserving backup result", async t => {
  const f = await fixture(t), credentials = f.auth();
  const prepared = await f.service.prepare(f.clientId, f.target, credentials);
  assert.equal(credentials.password, undefined); assert.equal(prepared.phase, "checked");
  assert.ok(f.calls[0].includes("removal.inspectRemoval("));
  assert.equal(await f.service.accepted(), true);
  const result = await f.service.execute(f.clientId, prepared.operationId, f.target, f.auth());
  assert.equal(result.phase, "uninstalled"); assert.equal(result.preserveData, true);
  assert.equal(result.extraSecret, undefined);
  const text = await fs.readFile(path.join(f.root, "infra/runtime/uninstallations", f.clientId + ".json"), "utf8");
  assert.ok(!text.includes("fixture-ssh-password") && !text.includes("must-not-persist"));
});
test("worker change or absent Linux acceptance blocks mutation before connecting", async t => {
  const f = await fixture(t), prepared = await f.service.prepare(f.clientId, f.target, f.auth());
  await fs.appendFile(path.join(f.root, "infra/scripts/uninstall-lms.cjs"), "\n// fixture change\n");
  assert.equal(await f.service.accepted(), false);
  await assert.rejects(f.service.execute(f.clientId, prepared.operationId, f.target, f.auth())); assert.equal(f.calls.length, 1);
});
test("expired plan or changed operation id cannot uninstall", async t => {
  const f = await fixture(t), prepared = await f.service.prepare(f.clientId, f.target, f.auth());
  await assert.rejects(f.service.execute(f.clientId, crypto.randomUUID(), f.target, f.auth()));
  const file = path.join(f.root, "infra/runtime/uninstallations", f.clientId + ".json");
  await fs.writeFile(file, JSON.stringify({ ...prepared, checkedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() }));
  await assert.rejects(f.service.execute(f.clientId, prepared.operationId, f.target, f.auth())); assert.equal(f.calls.length, 1);
});
test("disconnect blocks blind retries; saved server result can be read without re-running deletion", async t => {
  const f = await fixture(t), prepared = await f.service.prepare(f.clientId, f.target, f.auth());
  f.control.disconnected = true;
  await assert.rejects(f.service.execute(f.clientId, prepared.operationId, f.target, f.auth()));
  assert.equal((await f.service.get(f.clientId)).phase, "needs_attention");
  await assert.rejects(f.service.prepare(f.clientId, f.target, f.auth()));
  f.control.disconnected = false;
  f.control.result = { ...prepared, phase: "uninstalled", backupPath: `/srv/lms-core/backups/${f.clientId}/${prepared.operationId}` };
  assert.equal((await f.service.refresh(f.clientId, f.target, f.auth())).phase, "uninstalled");
  assert.ok(f.calls.at(-1).includes("REMOVAL_RECEIPT_UNAVAILABLE"));
});
test("corrupt local deletion record is not reset or overwritten", async t => {
  const f = await fixture(t), file = path.join(f.root, "infra/runtime/uninstallations", f.clientId + ".json");
  await fs.mkdir(path.dirname(file)); await fs.writeFile(file, "corrupt");
  await assert.rejects(f.service.prepare(f.clientId, f.target, f.auth()));
  assert.equal(await fs.readFile(file, "utf8"), "corrupt"); assert.equal(f.calls.length, 0);
});
test("completed uninstallation hides only its exact former installation, never another release/job", async t => {
  const f = await fixture(t), prepared = await f.service.prepare(f.clientId, f.target, f.auth());
  await f.service.execute(f.clientId, prepared.operationId, f.target, f.auth());
  await fs.mkdir(path.join(f.root, "infra/runtime/new-deployments"));
  const file = path.join(f.root, "infra/runtime/new-deployments", f.clientId + ".json"); await fs.writeFile(file, JSON.stringify(f.installed));
  const deployments = new NewDeploymentService(f.root, {}, {}, {}, { available: () => false, encrypt: () => Buffer.alloc(0) });
  assert.equal(await deployments.get(f.clientId), null);
  await fs.writeFile(file, JSON.stringify({ ...f.installed, id: crypto.randomUUID(), releaseId: crypto.randomUUID() }));
  assert.equal((await deployments.get(f.clientId)).phase, "succeeded");
});
