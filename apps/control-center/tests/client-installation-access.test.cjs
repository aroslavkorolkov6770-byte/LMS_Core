const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { ClientInstallationAccessStore } = require("../dist/client-installation-access.js");
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const make = () => ({ clientAdminName: "Fixture", clientAdminLogin: "admin", clientAdminPassword: randomBytes(24).toString("base64url"), systemAdminLogin: "sys_admin", systemAdminPassword: randomBytes(24).toString("base64url"), host: "192.0.2.11", sshUsername: "root", sshPort: 22, sshPassword: randomBytes(24).toString("base64url"), databaseMode: "local_peer", databaseHost: "192.0.2.11", databasePort: 5432, databaseUser: "postgres", databasePassword: "" });
const codec = { available: () => true, encrypt: text => Buffer.from(text).map(byte => byte ^ 0xa5), decrypt: bytes => Buffer.from(bytes).map(byte => byte ^ 0xa5).toString() };
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-access-test-")); t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("core-access-test-")); await fs.rm(root, { recursive: true, force: true }); }); return root; }
test("access metadata never returns passwords and a new store resolves them privately after reopening", async t => {
  const root = await fixture(t), input = make(), store = new ClientInstallationAccessStore(root, codec);
  const meta = await store.save(A, input, 0);
  assert.equal(meta.saved.clientAdminPassword, true); assert.equal(meta.saved.sshPassword, true);
  const disk = await fs.readFile(path.join(root, A + ".json"), "utf8");
  for (const key of ["clientAdminPassword", "systemAdminPassword", "sshPassword"]) { assert.ok(!JSON.stringify(meta).includes(input[key])); assert.ok(!disk.includes(input[key])); assert.equal(meta.values[key], undefined); }
  const reopened = new ClientInstallationAccessStore(root, codec);
  const resolved = await reopened.resolve(A, { useSavedAccess: true, clientAdminLogin: "admin", systemAdminLogin: "sys_admin" }, input);
  assert.equal(resolved.clientAdminPassword, input.clientAdminPassword); assert.equal(resolved.systemAdminPassword, input.systemAdminPassword);
});
test("blank passwords retain only the same account; changed host never inherits SSH or SQL passwords", async t => {
  const store = new ClientInstallationAccessStore(await fixture(t), codec), input = { ...make(), databaseMode: "manual", databasePassword: randomBytes(24).toString("base64url") };
  await store.save(A, input, 0);
  const blanks = { ...input, clientAdminPassword: "", systemAdminPassword: "", sshPassword: "", databasePassword: "" };
  assert.equal((await store.save(A, blanks, 1)).saved.clientAdminPassword, true);
  const changed = await store.save(A, { ...blanks, clientAdminLogin: "other_admin", host: "192.0.2.12", databaseHost: "192.0.2.12" }, 2);
  assert.equal(changed.saved.clientAdminPassword, false); assert.equal(changed.saved.systemAdminPassword, true); assert.equal(changed.saved.sshPassword, false); assert.equal(changed.saved.databasePassword, false);
});
test("another client, account or unpinned SSH target cannot use a saved credential", async t => {
  const store = new ClientInstallationAccessStore(await fixture(t), codec), input = make(); await store.save(A, input, 0);
  const target = { host: input.host, port: 22, username: "root", basePath: "/srv/lms-core/clients", fingerprint: "SHA256:" + "a".repeat(43) };
  assert.equal((await store.sshCredentials(target, { mode: "password", savedForClient: A })).password, input.sshPassword);
  await assert.rejects(store.sshCredentials({ ...target, host: "192.0.2.12" }, { mode: "password", savedForClient: A }));
  await assert.rejects(store.sshCredentials(target, { mode: "password", savedForClient: B }));
  await assert.rejects(store.sshCredentials({ ...target, fingerprint: "" }, { mode: "password", savedForClient: A }));
  await assert.rejects(store.resolve(A, { useSavedAccess: true, clientAdminLogin: "other" }, input));
});
test("stale revision, unavailable OS encryption and damaged records never overwrite the previous file", async t => {
  const root = await fixture(t), store = new ClientInstallationAccessStore(root, codec), input = make(); await store.save(A, input, 0);
  const before = await fs.readFile(path.join(root, A + ".json"), "utf8");
  await assert.rejects(store.save(A, input, 0));
  await assert.rejects(new ClientInstallationAccessStore(root, { ...codec, available: () => false }).save(A, input, 1));
  assert.equal(await fs.readFile(path.join(root, A + ".json"), "utf8"), before);
  const corrupted = JSON.parse(before); corrupted.clientId = B; await fs.writeFile(path.join(root, A + ".json"), JSON.stringify(corrupted));
  await assert.rejects(store.get(A)); await assert.rejects(store.save(A, input, 1));
});
test("manual PostgreSQL uses only its matching saved account; local peer does not retain its password", async t => {
  const store = new ClientInstallationAccessStore(await fixture(t), codec), input = { ...make(), databaseMode: "manual", databasePassword: randomBytes(24).toString("base64url") }; await store.save(A, input, 0);
  const body = { useSavedAccess: true, clientAdminLogin: input.clientAdminLogin, systemAdminLogin: input.systemAdminLogin, maintenanceUrl: `postgresql://postgres@${input.host}:5432/postgres` };
  const resolved = await store.resolve(A, body, input); assert.equal(decodeURIComponent(new URL(resolved.maintenanceUrl).password), input.databasePassword);
  const foreign = await store.resolve(A, { ...body, maintenanceUrl: "postgresql://postgres@192.0.2.12:5432/postgres" }, input); assert.equal(new URL(foreign.maintenanceUrl).password, "");
  assert.equal((await store.save(A, { ...input, databaseMode: "local_peer" }, 1)).saved.databasePassword, false);
});
test("unlock removes SSH access without losing administrator passwords; client deletion removes the file", async t => {
  const root = await fixture(t), store = new ClientInstallationAccessStore(root, codec); await store.save(A, make(), 0); await store.forgetSsh(A);
  const meta = await store.get(A); assert.equal(meta.saved.sshPassword, false); assert.equal(meta.saved.clientAdminPassword, true);
  await store.remove(A); assert.equal((await store.get(A)).revision, 0);
});
test("invalid login, weak password, unbound SSH password and secret in the hostname are rejected", async t => {
  const store = new ClientInstallationAccessStore(await fixture(t), codec), input = make();
  for (const patch of [{ systemAdminLogin: "system admin" }, { clientAdminPassword: "short" }, { host: "" }, { host: "http://user:secret@host" }]) assert.throws(() => store.save(A, { ...input, ...patch }, 0));
});
test("saved and manual credentials both satisfy the real installer's exact secret-field contract", async t => {
  const store = new ClientInstallationAccessStore(await fixture(t), codec), input = make(); await store.save(A, input, 0);
  const { validateSecrets } = require("../../../infra/scripts/lms-new-install-worker.cjs");
  const base = { databaseMode: "local_peer", clientAdminName: input.clientAdminName, clientAdminLogin: input.clientAdminLogin, systemAdminLogin: input.systemAdminLogin };
  for (const saved of [true, false]) {
    const resolved = await store.resolve(A, { ...base, clientAdminPassword: saved ? "" : input.clientAdminPassword, systemAdminPassword: saved ? "" : input.systemAdminPassword, useSavedAccess: saved }, input);
    assert.equal(Object.hasOwn(resolved, "useSavedAccess"), false);
    assert.doesNotThrow(() => validateSecrets({ ...resolved, databasePassword: randomBytes(32).toString("base64url") }));
  }
});
