const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RemoteTargetService, normalizeRemoteTarget, parseInventory, connectionFailure } = require("../dist/remote-target.js");
const key = Buffer.from("fixture public host key");
const fingerprint = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
const target = { host: "fixture.example", port: 22, username: "root", basePath: "/srv/lms-core/clients", fingerprint };
const output = 'user\troot\nkernel\tLinux\nos\t"Ubuntu fixture"\nnode\tv24.fixture\nnpm\t11.fixture\npostgresql\tactive\nmysql\tinactive\nmariadb\tinactive\npaths_begin\n/var/www/lms/package.json\npaths_end\n';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-ssh-test-"));
  t.after(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("core-ssh-test-")) throw new Error("Unsafe cleanup");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return root;
}

class FakeClient extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.executed = false; }
  connect(config) {
    this.config = config;
    setImmediate(() => {
      if (!config.hostVerifier(this.options.key || key)) this.emit("error", new Error("fixture-secret: host rejected"));
      else if (this.options.authFails) this.emit("error", new Error("fixture-secret: password rejected"));
      else this.emit("ready");
    });
  }
  exec(command, callback) {
    this.executed = true;
    if (this.options.preflight) assert.match(command, /^node - '[a-zA-Z0-9+/=]+'$/);
    else assert.equal(command, "sh -s");
    const channel = new EventEmitter();
    channel.stderr = new EventEmitter();
    channel.end = (script) => {
      this.script = script;
      setImmediate(() => { channel.emit("data", Buffer.from(this.options.output || output)); channel.emit("close", 0); });
    };
    callback(undefined, channel);
  }
  destroy() { this.emit("close"); }
  end() { this.destroy(); }
}

test("validates host, port, user, fingerprint and a separate Linux installation path", () => {
  assert.deepEqual(normalizeRemoteTarget(target), target);
  for (const changed of [{ host: "https://fixture.example" }, { host: "a;command" }, { port: 0 }, { username: "root;id" }, { basePath: "/" }, { basePath: "/srv/../etc" }, { fingerprint: "invalid" }]) {
    assert.throws(() => normalizeRemoteTarget({ ...target, ...changed }));
  }
});

test("saves only public fields, never an extra password or private key", async (t) => {
  const root = await fixture(t);
  const service = new RemoteTargetService(root);
  await service.saveTarget({ ...target, password: "fixture-secret", privateKey: "fixture-secret" });
  assert.deepEqual(await service.getTarget(), target);
  assert.ok(!(await fs.readFile(path.join(root, "infra/runtime/remote-target.json"), "utf8")).includes("fixture-secret"));
});

test("probe captures a fingerprint without credentials or automatic host trust", async (t) => {
  const root = await fixture(t);
  const client = new FakeClient();
  const service = new RemoteTargetService(root, () => client);
  assert.equal((await service.probe({ ...target, fingerprint: "" })).fingerprint, fingerprint);
  assert.equal(client.config.password, undefined);
  assert.equal(client.config.privateKey, undefined);
  assert.equal(client.executed, false);
  assert.equal((await service.getTarget()).fingerprint, "");
});

test("missing host pin refuses authentication before a connection is created", async (t) => {
  const root = await fixture(t);
  const service = new RemoteTargetService(root, () => { assert.fail("No connection without a host pin"); });
  await assert.rejects(service.inspect({ ...target, fingerprint: "" }, { mode: "password", password: "fixture-secret" }), /Пароль пока не отправлялся/);
});

test("changed host key blocks commands and sanitizes the error", async (t) => {
  const root = await fixture(t);
  const client = new FakeClient({ key: Buffer.from("other host") });
  const service = new RemoteTargetService(root, () => client);
  await assert.rejects(service.inspect(target, { mode: "password", password: "fixture-secret" }), /Отпечаток SSH-сервера не совпал/);
  assert.equal(client.executed, false);
});

test("successful inspection runs only the fixed read-only inventory and stores no credentials", async (t) => {
  const root = await fixture(t);
  const client = new FakeClient();
  const service = new RemoteTargetService(root, () => client);
  const result = await service.inspect(target, { mode: "password", password: "fixture-secret" });
  assert.equal(result.os, "Ubuntu fixture");
  assert.equal(result.postgres, "active");
  assert.deepEqual(result.projectPaths, ["/var/www/lms/package.json"]);
  assert.ok(!/apt |rm |restart|\.env|jlist|pg_dump|mysqldump/.test(client.script));
  const stored = await fs.readFile(path.join(root, "infra/runtime/remote-inventory.json"), "utf8");
  assert.ok(!stored.includes("fixture-secret"));
});

test("authentication failure is generic and cannot disclose the transport's raw error", async (t) => {
  const root = await fixture(t);
  const service = new RemoteTargetService(root, () => new FakeClient({ authFails: true }));
  await assert.rejects(service.inspect(target, { mode: "password", password: "fixture-secret" }), (error) => !error.message.includes("fixture-secret") && error.message.includes("SSH-вход"));
});

test("connection failure distinguishes rejected credentials, timeout, network and pin without raw errors", () => {
  for (const [input, code] of [[{ level: "client-authentication" }, "SSH_AUTH_REJECTED"], [{ level: "client-timeout" }, "SSH_TIMEOUT"],
    [{ code: "ECONNREFUSED" }, "SSH_UNREACHABLE"], [{ code: "ECONNRESET" }, "SSH_CONNECTION_CLOSED"], [{}, "SSH_CONNECTION_FAILED"]]) {
    const error = connectionFailure({ ...input, message: "fixture-secret", stderr: "fixture-secret" });
    assert.equal(error.code, code);
    assert.ok(!error.message.includes("fixture-secret"));
  }
  assert.equal(connectionFailure({ level: "client-authentication" }, true).code, "SSH_HOST_CHANGED");
});

test("inventory parser rejects an unconfirmed platform and ignores unrelated server text", () => {
  assert.throws(() => parseInventory("kernel\tOther\nuser\troot\n"), /Linux/);
  assert.equal(JSON.stringify(parseInventory(`${output}\nunknown\tignored\n`)).includes("ignored"), false);
});

test("saved connection evidence remains historical and is hidden for a changed server", async (t) => {
  const root = await fixture(t);
  const service = new RemoteTargetService(root, () => new FakeClient());
  await service.saveTarget(target);
  await service.inspect(target, { mode: "password", password: "fixture-secret" });
  assert.equal((await service.getState()).inventory.os, "Ubuntu fixture");
  await service.saveTarget({ ...target, host: "other.example" });
  assert.equal((await service.getState()).inventory, null);
});

test("preflight accepts only a selected app root and a fixed Node command, with no secret persistence", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts/lms-update-preflight.cjs"), path.join(root, "infra/scripts/lms-update-preflight.cjs"));
  const result = { checkedAt: new Date().toISOString(), appRoot: "/var/www/lms", backend: "json", environmentFiles: [], protectedPaths: [],
    warnings: [], managers: { pm2: [], systemd: [] }, packageManager: "npm", projectKind: "nextjs", hasBuild: true, hasStart: true,
    diskFreeBytes: 1000, memoryTotalBytes: 1000, memoryFreeBytes: 500 };
  const client = new FakeClient({ preflight: true, output: JSON.stringify(result) });
  const service = new RemoteTargetService(root, () => client);
  const selected = { ...target, appPath: "/var/www/lms" };
  await service.saveTarget(selected);
  assert.deepEqual(await service.preflight(selected, { mode: "password", password: "fixture-secret" }), result);
  assert.equal((await service.getState()).preflight.backend, "json");
  const stored = await fs.readFile(path.join(root, "infra/runtime/remote-preflight.json"), "utf8");
  assert.ok(!stored.includes("fixture-secret"));
  await service.saveTarget({ ...selected, appPath: "/var/www/another" });
  assert.equal((await service.getState()).preflight, null);
});

test("preflight refuses build directories, traversal and an unspecified app without connecting", async (t) => {
  const root = await fixture(t);
  const service = new RemoteTargetService(root, () => { assert.fail("No connection for invalid app paths"); });
  await assert.rejects(service.preflight(target, { mode: "password", password: "fixture-secret" }), /каталог существующей LMS/);
  for (const appPath of ["/", "/var/www/.next", "/var/www/app/../other", "/var/www/node_modules/x", "/var/www/app;id"]) {
    assert.throws(() => normalizeRemoteTarget({ ...target, appPath }));
  }
});
