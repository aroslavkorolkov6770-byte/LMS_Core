const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { ClientServerStore, serverCredentialId } = require("../dist/client-servers.js");
const { RemoteTargetService } = require("../dist/remote-target.js");
const { EventEmitter } = require("node:events");
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const target = { host: "one.example", port: 22, username: "root", fingerprint: "SHA256:" + "a".repeat(43), basePath: "/srv/lms-core/clients" };
const other = { ...target, host: "two.example" };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-client-servers-"));
  const key = crypto.randomBytes(32);
  const protector = {
    available: () => true,
    encrypt: (value) => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
    decrypt: (value) => { const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(); }
  };
  t.after(async () => { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("core-client-servers-")) throw Error("UNSAFE_FIXTURE"); await fs.rm(root, { recursive: true, force: true }); });
  return { root, protector, store: new ClientServerStore(root, protector) };
}
test("explicit lock persists across store restart; no plaintext or ciphertext is returned to renderer", async (t) => {
  const f = await fixture(t), password = "fixture-secret-only-З12";
  assert.deepEqual(await f.store.get(A), { clientId: A, revision: 0, target: null, passwordSaved: false });
  const saved = await f.store.remember(A, target, password, 0);
  assert.equal(saved.passwordSaved, true); assert.equal(saved.revision, 1);
  assert.ok(!JSON.stringify(saved).includes("passwords")); assert.ok(!JSON.stringify(saved).includes(password));
  const disk = await fs.readFile(path.join(f.root, `${A}.json`), "utf8"); assert.ok(!disk.includes(password));
  const restarted = new ClientServerStore(f.root, f.protector);
  assert.equal((await restarted.get(A)).target.host, target.host);
  assert.equal((await restarted.credentials(target, { mode: "password", savedForClient: A })).password, password);
});
test("client/host/user/port/SSH pin isolate passwords; paths do not change SSH identity", async (t) => {
  const { store } = await fixture(t); await store.remember(A, target, "first-secret", 0);
  for (const changed of [other, { ...target, username: "ubuntu" }, { ...target, port: 2222 }, { ...target, fingerprint: "SHA256:" + "b".repeat(43) }]) {
    assert.equal((await store.get(A, changed)).passwordSaved, false);
    await assert.rejects(store.credentials(changed, { mode: "password", savedForClient: A }));
  }
  await assert.rejects(store.credentials(target, { mode: "password", savedForClient: B }));
  assert.equal(serverCredentialId(target), serverCredentialId({ ...target, appPath: "/srv/lms-core/clients/example" }));
});

test("deleting a client forgets only its encrypted profile", async t => {
  const f = await fixture(t);
  await f.store.remember(A, target, "first-secret", 0);
  await f.store.remember(B, other, "second-secret", 0);
  await f.store.remove(A);
  assert.equal((await f.store.get(A)).passwordSaved, false);
  assert.equal((await f.store.credentials(other, { mode: "password", savedForClient: B })).password, "second-secret");
  await f.store.remove(A);
  await assert.rejects(f.store.remove("../another-profile"));
});
test("switching hosts and clients retains separate records; unlock forgets only the selected password", async (t) => {
  const { store } = await fixture(t);
  await store.remember(A, target, "one", 0); await store.remember(A, other, "two", 1); await store.remember(B, target, "three", 0);
  await store.saveTarget(A, target, 2); assert.equal((await store.get(A)).passwordSaved, true);
  assert.equal((await store.forget(A, target, 3)).passwordSaved, false);
  await assert.rejects(store.credentials(target, { mode: "password", savedForClient: A }));
  assert.equal((await store.credentials(other, { mode: "password", savedForClient: A })).password, "two");
  assert.equal((await store.credentials(target, { mode: "password", savedForClient: B })).password, "three");
});
test("public save never stores credentials or unknown fields; locks require verified pin", async (t) => {
  const { store, root } = await fixture(t);
  await store.saveTarget(A, { ...target, password: "must-not-save", apiToken: "nope" }, 0);
  assert.ok(!(await fs.readFile(path.join(root, `${A}.json`), "utf8")).includes("must-not-save"));
  await assert.rejects(async () => store.remember(A, { ...target, fingerprint: "" }, "password", 1));
  await assert.rejects(async () => store.remember(A, target, "", 1));
  await assert.rejects(store.credentials(target, { mode: "password", password: "override", savedForClient: A }));
});
test("stale revisions and concurrent writes cannot replace a newer password", async (t) => {
  const { store } = await fixture(t);
  const result = await Promise.allSettled([store.remember(A, target, "first", 0), store.remember(A, other, "second", 0)]);
  assert.equal(result.filter(value => value.status === "fulfilled").length, 1);
  assert.equal((await store.get(A)).revision, 1);
  await assert.rejects(store.forget(A, target, 0));
  assert.equal((await store.credentials(target, { mode: "password", savedForClient: A })).password, "first");
});
test("unavailable OS protector or corrupt file fails closed without resetting existing data", async (t) => {
  const f = await fixture(t); await f.store.remember(A, target, "secret", 0);
  const unavailable = new ClientServerStore(f.root, { ...f.protector, available: () => false });
  await assert.rejects(async () => unavailable.remember(A, target, "replacement", 1));
  await assert.rejects(unavailable.credentials(target, { mode: "password", savedForClient: A }));
  const file = path.join(f.root, `${A}.json`); await fs.writeFile(file, "damaged");
  await assert.rejects(f.store.saveTarget(A, target, 0)); assert.equal(await fs.readFile(file, "utf8"), "damaged");
  await assert.rejects(f.store.get("../outside"));
});
test("moving encrypted value between clients or hosts cannot rebind credentials", async (t) => {
  const f = await fixture(t); await f.store.remember(A, target, "secret", 0); await f.store.saveTarget(B, other, 0);
  const one = JSON.parse(await fs.readFile(path.join(f.root, `${A}.json`))), file = path.join(f.root, `${B}.json`);
  const two = JSON.parse(await fs.readFile(file)); two.passwords[serverCredentialId(other)] = one.passwords[serverCredentialId(target)]; await fs.writeFile(file, JSON.stringify(two));
  await assert.rejects(f.store.credentials(other, { mode: "password", savedForClient: B }));
});
test("unchanged profile does not rewrite disk or advance its revision", async (t) => {
  const f = await fixture(t); await f.store.remember(A, target, "secret", 0);
  const file = path.join(f.root, `${A}.json`), before = await fs.readFile(file, "utf8");
  assert.equal((await f.store.saveTarget(A, target, 1)).revision, 1);
  assert.equal(await fs.readFile(file, "utf8"), before);
});
test("encryption failures never leak protector error or overwrite the previous credential", async (t) => {
  const f = await fixture(t); await f.store.remember(A, target, "previous", 0);
  const broken = new ClientServerStore(f.root, { ...f.protector, encrypt: () => { throw Error("raw fixture-private-message"); } });
  await assert.rejects(broken.remember(A, target, "new", 1), error => !error.message.includes("fixture-private"));
  assert.equal((await f.store.credentials(target, { mode: "password", savedForClient: A })).password, "previous");
});
test("SSH transport resolves saved credentials only in main process and still verifies the host key", async (t) => {
  const f = await fixture(t), hostKey = Buffer.from("fixture key");
  const pinned = { ...target, fingerprint: "SHA256:" + crypto.createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "") };
  await f.store.remember(A, pinned, "fixture-ssh-secret", 0);
  let seen;
  class Transport extends EventEmitter {
    connect(options) { seen = options; setImmediate(() => { if (options.hostVerifier(hostKey)) this.emit("ready"); else this.emit("error", Error("changed key")); }); }
    destroy() { this.emit("close"); }
  }
  const remote = new RemoteTargetService(f.root, () => new Transport(), (selected, auth) => f.store.credentials(selected, auth));
  const auth = { mode: "password", savedForClient: A };
  assert.equal(await remote.withSession(pinned, auth, async () => seen.password === "fixture-ssh-secret"), true);
  assert.equal(auth.password, undefined); assert.equal(seen.password, "fixture-ssh-secret");
  await f.store.remember(A, target, "other-key-secret", 1);
  await assert.rejects(remote.withSession(target, auth, async () => assert.fail("must not run")), error => error.code === "SSH_HOST_CHANGED");
});
