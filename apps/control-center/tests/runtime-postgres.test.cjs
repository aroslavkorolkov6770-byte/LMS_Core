const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const { root, dbRequire, loadAdapter } = require("./runtime-test-helper.cjs");
const { loadBaseline, fixtureClient, db } = require("./fresh-install-test-helper.cjs");

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRuntime(databaseUrl, clientId, bootstrapEnabled, encryptionKey = randomBytes(32).toString("hex")) {
  const port = await unusedPort();
  const token = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [path.join(root, "apps/api/dist/runtime-main.js")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "production", DATABASE_URL: databaseUrl,
      LMS_RUNTIME_CLIENT_ID: clientId, LMS_RUNTIME_SERVICE_TOKEN: token, LMS_RUNTIME_ENCRYPTION_KEY: encryptionKey,
      LMS_RUNTIME_BOOTSTRAP_ENABLED: String(bootstrapEnabled), LMS_RUNTIME_PORT: String(port), LMS_RUNTIME_LISTEN_HOST: "127.0.0.1" }
  });
  // Never relay a child environment or raw driver output to the test log.
  child.stdout.resume(); child.stderr.resume();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const close = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
  const origin = `http://127.0.0.1:${port}`;
  const call = async (action, body, options = {}) => {
    const response = await fetch(`${origin}/api/${action}`, { method: body === undefined ? "GET" : action.endsWith("write") ? "PUT" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Isolated runtime process exited before readiness");
      try { if ((await call("lms-runtime/v1/health")).status === 200) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Isolated runtime did not become ready");
    return { call, close, origin, token, encryptionKey };
  } catch (error) { await close(); throw error; }
}

test("real isolated PostgreSQL and private Nest API preserve data, revisions and bootstrap", { timeout: 120000 }, async (t) => {
  const config = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8"));
  const databaseUrl = new URL(config.environment.DATABASE_URL);
  // A test may create/drop only its own database on the known local PostgreSQL service.
  assert.ok(["127.0.0.1", "localhost"].includes(databaseUrl.hostname));
  assert.equal(databaseUrl.port, "55432");
  const name = `core_runtime_test_${randomBytes(8).toString("hex")}`;
  assert.match(name, /^core_runtime_test_[a-f0-9]{16}$/);
  const postgres = dbRequire("postgres");
  const maintenance = new URL(databaseUrl); maintenance.pathname = "/postgres";
  const admin = postgres(maintenance.href, { max: 1, onnotice: () => {} });
  let sql;
  let runtime;
  let other;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    databaseUrl.pathname = `/${name}`;
    sql = postgres(databaseUrl.href, { max: 1, onnotice: () => {} });
    const clientId = randomUUID(), secondClient = randomUUID();
    await db.initializeFreshDatabase(databaseUrl.href, await loadBaseline(), { ...fixtureClient(), id: clientId });
    await sql`INSERT INTO clients (id, name, slug, domain, brand_name, tariff) VALUES (${secondClient}, 'Second isolated fixture', 'fixture-two', 'two.invalid', 'Fixture', 'base')`;
    runtime = await startRuntime(databaseUrl.href, clientId, true);
    const read = (keys) => runtime.call("lms-runtime/v1/read", { keys });
    const write = (key, data, expectedRevision) => runtime.call("lms-runtime/v1/write", { key, data, expectedRevision });
    const input = { clientAdminLogin: "fixture.admin", clientAdminName: "Fixture Admin", clientAdminPassword: randomBytes(24).toString("base64url"),
      systemAdminLogin: "fixture.system", systemAdminPassword: randomBytes(24).toString("base64url") };

    await t.test("private routes require a token, expose no control plane and reject tenant overrides", async () => {
      assert.equal((await runtime.call("lms-runtime/v1/health", undefined, { headers: { Authorization: "", "x-dev-role": "system_admin" } })).status, 401);
      assert.equal((await runtime.call("deploy-panel/clients")).status, 404);
      assert.equal((await runtime.call("lms-runtime/v1/read", { keys: ["content"], clientId: secondClient })).status, 400);
      assert.equal((await read(["tea_hub_users_v1"])).status, 409);
      const response = await fetch(`${runtime.origin}/api/lms-runtime/v1/read`, { method: "POST", headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" }, body: "{" });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "INVALID_REQUEST");
    });

    let initialUsers;
    await t.test("one-time administrator initialization cannot overwrite existing credentials", async () => {
      const response = await runtime.call("lms-runtime/v1/bootstrap", input);
      assert.equal(response.status, 201);
      assert.equal(response.body.initialized, true);
      assert.equal(JSON.stringify(response.body).includes(input.clientAdminPassword), false);
      initialUsers = (await read(["tea_hub_users_v1"])).body.entries[0].data;
      assert.equal(initialUsers.length, 2);
      assert.equal(initialUsers[1].systemAccount, true);
      assert.equal((await runtime.call("lms-runtime/v1/bootstrap", { ...input, clientAdminPassword: randomBytes(24).toString("base64url") })).status, 409);
      assert.deepEqual((await read(["core_lms_users_v1"])).body.entries[0].data, initialUsers);
      assert.equal((await write("tea_hub_users_v1", [initialUsers[0]], 1)).status, 400);
      assert.equal((await write("tea_hub_users_v1", initialUsers.map((user) => ({ ...user, password: "forbidden" })), 1)).status, 400);
    });

    const secret = randomBytes(24).toString("base64url");
    await t.test("writes create encrypted history, reject stale versions and serialize first-write races", async () => {
      assert.equal((await write("tea_hub_products_v1", { private: secret }, 0)).status, 200);
      assert.equal((await write("tea_hub_products_v1", { private: `${secret}-next` }, 1)).body.revision, 2);
      assert.equal((await write("tea_hub_products_v1", { stale: true }, 1)).status, 409);
      // Two independent pools/processes exercise PostgreSQL row locking, not just one pool's queue.
      other = await startRuntime(databaseUrl.href, clientId, false, runtime.encryptionKey);
      assert.deepEqual((await other.call("lms-runtime/v1/read", { keys: ["tea_hub_users_v1"] })).body.entries[0].data, initialUsers);
      const results = await Promise.all([write("race", { version: 1 }, 0), other.call("lms-runtime/v1/write", { key: "race", data: { version: 2 }, expectedRevision: 0 })]);
      assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
      await other.close(); other = null;
      const [row] = await sql`SELECT storage_key, revision, encrypted_payload FROM lms_runtime_values WHERE client_id=${clientId} AND storage_key='core_lms_products_v1'`;
      assert.equal(row.revision, 2);
      assert.equal(JSON.stringify(row.encrypted_payload).includes(secret), false);
      const history = await sql`SELECT revision, encrypted_payload FROM lms_runtime_value_history WHERE client_id=${clientId} AND storage_key='core_lms_products_v1'`;
      assert.deepEqual(history.map((row) => row.revision), [1]);
      assert.equal(JSON.stringify(history).includes(secret), false);
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM lms_runtime_values WHERE storage_key LIKE 'tea_hub_%'`;
      assert.equal(count, 0);
    });

    await t.test("the actual source adapter reads and writes through HTTP without a file fallback", async () => {
      const store = loadAdapter().createCoreRuntimeStore({ apiUrl: runtime.origin, serviceToken: runtime.token });
      await store.writeDataValue("lesson_content", { text: "Fixture lesson", nested: [1, 2] });
      assert.equal((await store.readDataValue("lesson_content", null)).text, "Fixture lesson");
      assert.equal((await store.readDataValue("tea_hub_users_v1", [])).length, 2);
      assert.equal(await store.readDataValue("missing", "fallback"), "fallback");
      assert.equal((await write("lesson_content", null, 1)).body.revision, 2);
      assert.equal(await store.readDataValue("lesson_content", "deleted"), "deleted");
      assert.equal((await write("lesson_content", { restored: true }, 0)).status, 409);
      assert.equal((await write("lesson_content", { restored: true }, 2)).status, 200);
    });

    await t.test("a second runtime cannot read another tenant and cannot bootstrap while disabled", async () => {
      other = await startRuntime(databaseUrl.href, secondClient, false);
      const response = await other.call("lms-runtime/v1/read", { keys: ["tea_hub_products_v1"] });
      assert.equal(response.body.entries[0].found, false);
      assert.equal((await other.call("lms-runtime/v1/bootstrap", input)).status, 403);
      const audit = await sql`SELECT details FROM audit_log`;
      assert.equal(JSON.stringify(audit).includes(secret), false);
      assert.equal(JSON.stringify(audit).includes(input.clientAdminPassword), false);
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
      assert.equal(count, 0);
    });
  } finally {
    if (other) await other.close();
    if (runtime) await runtime.close();
    if (sql) await sql.end({ timeout: 5 });
    try {
      if (created) {
        assert.match(name, /^core_runtime_test_[a-f0-9]{16}$/);
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    } finally { await admin.end({ timeout: 5 }); }
  }
});
