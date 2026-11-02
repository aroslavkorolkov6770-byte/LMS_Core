const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { RemoteDeploymentService } = require("../dist/remote-deployment.js");
const target = { host: "fixture.example", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/var/www/fixture", fingerprint: "SHA256:" + "A".repeat(43) };

async function fixture(t, behavior = "succeeded") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-deploy-ssh-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("core-deploy-ssh-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  await fs.copyFile(path.join(__dirname, "../../../infra/scripts/lms-update-worker.cjs"), path.join(root, "infra/scripts/lms-update-worker.cjs"));
  const archivePath = path.join(root, "code.tar");
  await fs.writeFile(archivePath, "fixture code only");
  const calls = [];
  const auth = { mode: "password", password: "fixture-private-password" };
  const remote = { withSession: async (actual, credentials, action) => {
    assert.equal(credentials.password, "fixture-private-password");
    assert.deepEqual(actual, target);
    return action({ execute: async (command, input) => {
      calls.push({ command, input });
      if (command.startsWith("nohup") && behavior === "disconnect") throw new Error("fixture private transport detail");
      if (command.startsWith("cat") || (command === "node -" && String(input).includes("worker.pid"))) {
        return JSON.stringify({ phase: behavior === "disconnect" ? "succeeded" : behavior, updatedAt: new Date().toISOString(), backupPath: "/var/backups/lms-core/fixture/installation.tar.gz", unknownSecret: "fixture-private-password", port: 3000 });
      }
      return "";
    } });
  } };
  const packages = { prepare: async () => ({ archivePath, revision: "a".repeat(40), sha256: crypto.createHash("sha256").update("fixture code only").digest("hex") }) };
  return { root, calls, auth, service: new RemoteDeploymentService(root, remote, packages) };
}

test("deploy sends only filtered code/config and persists an allowlisted result, never credentials", async (t) => {
  const { root, calls, auth, service } = await fixture(t);
  const progress = [];
  const result = await service.deploy(target, auth, "fixture-snapshot", true, (state) => progress.push(state.phase));
  assert.equal(result.phase, "succeeded");
  assert.ok(calls.some((call) => call.command.startsWith("nohup")));
  assert.ok(calls.some((call) => Buffer.isBuffer(call.input) && call.input.toString() === "fixture code only"));
  assert.ok(calls.every((call) => !call.command.includes("fixture-private-password")));
  assert.equal(auth.password, undefined);
  const stored = await fs.readFile(path.join(root, "infra/runtime/remote-deployment.json"), "utf8");
  assert.ok(!stored.includes("fixture-private-password") && !stored.includes("unknownSecret"));
  assert.equal(progress[0], "preparing");
  assert.equal(progress.at(-1), "succeeded");
});

test("disconnect after launch is uncertain, blocks another deployment and supports a read-only result check", async (t) => {
  const { service, auth } = await fixture(t, "disconnect");
  const result = await service.deploy(target, auth, "fixture-snapshot", false, () => {});
  assert.equal(result.phase, "disconnected");
  assert.ok(!result.message.includes("fixture private transport detail"));
  await assert.rejects(service.deploy(target, { mode: "password", password: "fixture-private-password" }, "fixture-snapshot", false, () => {}), /Повторная установка заблокирована/);
  assert.equal((await service.refresh(target, { mode: "password", password: "fixture-private-password" }, () => {})).phase, "succeeded");
});

test("result check refuses changed host or application path without connecting", async (t) => {
  const { service, auth, calls } = await fixture(t);
  await service.deploy(target, auth, "fixture-snapshot", false, () => {});
  const count = calls.length;
  await assert.rejects(service.refresh({ ...target, appPath: "/var/www/other" }, { mode: "password", password: "fixture-private-password" }, () => {}), /не совпали/);
  assert.equal(calls.length, count);
});

test("failed automatic recovery blocks new deployment until an operator resolves it", async (t) => {
  const { service, auth } = await fixture(t, "needs_attention");
  assert.equal((await service.deploy(target, auth, "fixture-snapshot", false, () => {})).phase, "needs_attention");
  await assert.rejects(service.deploy(target, { mode: "password", password: "fixture-private-password" }, "fixture-snapshot", false, () => {}), /Повторная установка заблокирована/);
});
