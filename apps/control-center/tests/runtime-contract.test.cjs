const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID, scryptSync } = require("node:crypto");
const { RuntimeCryptoService } = require("../../api/dist/modules/lms-runtime/runtime-crypto.service.js");
const { RuntimeGuard } = require("../../api/dist/modules/lms-runtime/runtime.guard.js");
const { runtimeKey, serializeRuntimePayload, createRuntimeAccounts, validateRuntimeUsers } = require("../../api/dist/modules/lms-runtime/runtime-contract.js");
const { loadAdapter } = require("./runtime-test-helper.cjs");
const config = (values) => ({ get: (key, fallback) => values[key] ?? fallback });
const token = randomBytes(32).toString("base64url");
const tenant = randomUUID();
const requestContext = (request) => ({ switchToHttp: () => ({ getRequest: () => request }) });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const entry = (key, revision = 0) => ({ protocol: "lms-core-runtime-v1", entries: [{ key, requestedKey: key, found: false, revision, data: null }] });

test("runtime keys canonicalize legacy names without prototype inheritance", () => {
  assert.equal(runtimeKey("tea_hub_users_v1"), "core_lms_users_v1");
  assert.equal(runtimeKey("tea_hub_custom_v2"), "core_lms_custom_v2");
  assert.equal(runtimeKey("th_ai_history_user"), "core_lms_ai_history_user");
  assert.equal(runtimeKey("toString"), "toString");
  for (const key of ["__proto__", "constructor", "prototype", "../users", "", "a".repeat(201), null]) assert.throws(() => runtimeKey(key));
  assert.throws(() => serializeRuntimePayload(undefined));
  assert.throws(() => serializeRuntimePayload({ value: 1n }));
});

test("runtime encryption binds ciphertext to tenant, key and revision", () => {
  const service = new RuntimeCryptoService(config({ "runtime.encryptionKey": randomBytes(32).toString("hex") }));
  const text = JSON.stringify({ private: "isolated-fixture" });
  const encrypted = service.encrypt(text, tenant, "content", 1);
  assert.equal(JSON.stringify(encrypted).includes("isolated-fixture"), false);
  assert.deepEqual(service.decrypt(encrypted, tenant, "content", 1), JSON.parse(text));
  assert.notEqual(service.encrypt(text, tenant, "content", 1).iv, encrypted.iv);
  for (const args of [[randomUUID(), "content", 1], [tenant, "different", 1], [tenant, "content", 2]]) assert.throws(() => service.decrypt(encrypted, ...args));
  assert.throws(() => service.decrypt({ ...encrypted, tag: Buffer.alloc(16).toString("base64") }, tenant, "content", 1));
  assert.throws(() => new RuntimeCryptoService(config({})).encrypt(text, tenant, "content", 1));
});

test("runtime access ignores development roles and fixes tenant on the server", () => {
  const guard = new RuntimeGuard(config({ "runtime.clientId": tenant, "runtime.serviceToken": token }));
  assert.throws(() => guard.canActivate(requestContext({ headers: { "x-dev-role": "system_admin" } })), (error) => error.getStatus() === 401);
  assert.throws(() => guard.canActivate(requestContext({ headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` } })), (error) => error.getStatus() === 401);
  const request = { headers: { authorization: `Bearer ${token}` }, runtimeClientId: randomUUID() };
  assert.equal(guard.canActivate(requestContext(request)), true);
  assert.equal(request.runtimeClientId, tenant);
  assert.throws(() => new RuntimeGuard(config({})).canActivate(requestContext(request)), (error) => error.getStatus() === 503);
});

test("bootstrap creates distinct administrators with compatible salted scrypt hashes", () => {
  const password = randomBytes(20).toString("base64url");
  const input = { clientAdminLogin: "client.admin", clientAdminPassword: password, clientAdminName: "Fixture", systemAdminLogin: "system.admin", systemAdminPassword: password };
  const users = createRuntimeAccounts(input);
  validateRuntimeUsers(users);
  assert.equal(users.length, 2);
  assert.equal(users[0].role, "admin");
  assert.equal(users[1].canSwitchMode, true);
  assert.notEqual(users[0].passHash, users[1].passHash);
  assert.equal(JSON.stringify(users).includes(password), false);
  for (const user of users) {
    const [prefix, salt, hash] = user.passHash.split("$");
    assert.equal(prefix, "scrypt2");
    assert.equal(scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex"), hash);
  }
  assert.throws(() => createRuntimeAccounts({ ...input, systemAdminLogin: "CLIENT.ADMIN" }));
  assert.throws(() => createRuntimeAccounts({ ...input, clientAdminPassword: "short" }));
  assert.throws(() => validateRuntimeUsers(users.slice(0, 1)));
  assert.throws(() => validateRuntimeUsers([{ ...users[0], password }, users[1]]));
  assert.throws(() => validateRuntimeUsers([users[0], { ...users[1], login: "CLIENT.ADMIN" }]));
});

test("adapter rejects missing credentials, public plain HTTP and URL credentials", () => {
  const { createCoreRuntimeStore, readDataValue } = loadAdapter();
  for (const apiUrl of ["", "http://example.invalid", "https://user:password@example.invalid", "https://example.invalid/path", "https://example.invalid?token=x"]) {
    assert.throws(() => createCoreRuntimeStore({ apiUrl, serviceToken: token }));
  }
  assert.throws(() => createCoreRuntimeStore({ apiUrl: "http://127.0.0.1:4101", serviceToken: "" }));
  assert.throws(() => readDataValue("content", []));
});

test("adapter sends only private bearer requests and maps missing values", async () => {
  const { createCoreRuntimeStore } = loadAdapter();
  let calls = 0;
  const store = createCoreRuntimeStore({ apiUrl: "http://127.0.0.1:4101", serviceToken: token, fetcher: async (url, options) => {
    calls++;
    assert.equal(url.pathname, "/api/lms-runtime/v1/read");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, "error");
    return json(entry("content"));
  } });
  assert.equal(await store.readDataValue("content", "fallback"), "fallback");
  assert.equal(JSON.stringify(await store.readDataValues(["content", "content"])), '{"content":[]}');
  assert.equal(calls, 2);
});

test("adapter checks response protocol and never exposes transport secrets", async () => {
  const { createCoreRuntimeStore } = loadAdapter();
  for (const fetcher of [async () => json({ protocol: "other" }), async () => json(entry("wrong")), async () => { throw new Error(token); }]) {
    const store = createCoreRuntimeStore({ apiUrl: "http://127.0.0.1:4101", serviceToken: token, fetcher });
    await assert.rejects(store.readDataValue("content", []), (error) => error.status === 503 && !error.message.includes(token));
  }
});

test("adapter uses expected revision and does not retry a rejected write", async () => {
  const { createCoreRuntimeStore } = loadAdapter();
  let calls = 0;
  const store = createCoreRuntimeStore({ apiUrl: "http://127.0.0.1:4101", serviceToken: token, fetcher: async (_url, options) => {
    calls++;
    if (options.method === "POST") return json(entry("content", 4));
    assert.equal(JSON.parse(options.body).expectedRevision, 4);
    return json({ error: "REVISION_CONFLICT" }, 409);
  } });
  await assert.rejects(store.writeDataValue("content", { value: 1 }), (error) => error.status === 409);
  assert.equal(calls, 2);
});
