const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { Readable, PassThrough } = require("node:stream");
const { databaseProvisionFixture, db } = require("./database-provision-test-helper.cjs");
const { loadBaseline, fixtureClient } = require("./fresh-install-test-helper.cjs");
const { readProvisionInput, runRuntimeProvisioning } = require("../../api/dist/runtime-provision.js");
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("database provision rejects invalid identifiers, secrets and URL identity overrides before connecting", async () => {
  const input = { clientId: randomUUID(), jobId: randomUUID(), password: randomBytes(32).toString("base64url") };
  assert.throws(() => db.clientDatabaseNames("../other"), (error) => error.code === "INVALID_DATABASE_CLIENT");
  await rejectsCode(db.provisionClientDatabase("postgresql://fixture@127.0.0.1/postgres", { ...input, password: "short" }), "INVALID_DATABASE_SERVICE_PASSWORD");
  await rejectsCode(db.provisionClientDatabase("postgresql://fixture@127.0.0.1/other", input), "DATABASE_MAINTENANCE_REQUIRED");
  for (const parameter of ["username=postgres", "password=other", "database=other", "host=remote.invalid", "sslmode=disable&sslmode=require"]) {
    assert.throws(() => db.clientDatabaseUrl(`postgresql://fixture@127.0.0.1/postgres?${parameter}`, input.clientId, input.password), (error) => error.code === "INVALID_DATABASE_CONFIG");
  }
  const url = new URL(db.clientDatabaseUrl("postgresql://fixture@127.0.0.1/postgres?sslmode=verify-full", input.clientId, input.password));
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.equal(url.username, db.clientDatabaseNames(input.clientId).role);
});

test("database provisioning input is bounded and malformed input never reaches PostgreSQL", async () => {
  assert.deepEqual(await readProvisionInput(Readable.from(['{"fixture":true}'])), { fixture: true });
  await rejectsCode(readProvisionInput(Readable.from(["bad json"])), "INVALID_DATABASE_PROVISION_INPUT");
  await rejectsCode(readProvisionInput(Readable.from(["x".repeat(16385)])), "DATABASE_PROVISION_INPUT_TOO_LARGE");
  await rejectsCode(readProvisionInput(new PassThrough(), 15), "DATABASE_PROVISION_INPUT_TIMEOUT");
  for (const input of [null, [], {}, { maintenanceUrl: "invalid", clientId: randomUUID(), jobId: randomUUID(), password: "short", extra: true }]) {
    await rejectsCode(runRuntimeProvisioning(input), "INVALID_DATABASE_PROVISION_INPUT");
  }
});

test("real PostgreSQL provision creates a restricted owner and full empty baseline, then reuses without resetting password/data", { timeout: 60000 }, async (t) => {
  const f = await databaseProvisionFixture(t);
  const first = await db.provisionClientDatabase(f.maintenanceUrl, f.input);
  assert.equal(first.reused, false); assert.equal(first.provisioned, true);
  assert.equal(JSON.stringify(first).includes(f.input.password), false);
  assert.equal((await db.assertRestrictedDatabaseRole(f.databaseUrl, f.input.clientId)).restricted, true);
  const sql = f.connect(f.databaseUrl);
  const client = { ...fixtureClient(), id: f.input.clientId };
  assert.equal((await db.initializeFreshDatabase(f.databaseUrl, await loadBaseline(), client)).initialized, true);
  const [counts] = await sql`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM courses) AS courses,
    (SELECT count(*)::int FROM tests) AS tests`;
  assert.deepEqual({ ...counts }, { users: 0, courses: 0, tests: 0 });
  for (const command of ["CREATE DATABASE core_forbidden_fixture", "CREATE ROLE core_forbidden_fixture", "SET ROLE postgres"]) {
    await assert.rejects(sql.unsafe(command), (error) => error.code === "42501");
  }
  const [before] = await f.admin`SELECT rolpassword FROM pg_authid WHERE rolname=${f.names.role}`;
  assert.match(before.rolpassword, /^SCRAM-SHA-256\$4096:/);
  await sql`UPDATE clients SET brand_name='Preserved fixture' WHERE id=${f.input.clientId}`;
  assert.equal((await db.provisionClientDatabase(f.maintenanceUrl, f.input)).reused, true);
  await rejectsCode(db.provisionClientDatabase(f.maintenanceUrl, { ...f.input, password: randomBytes(32).toString("base64url") }), "DATABASE_SERVICE_PASSWORD_MISMATCH");
  await rejectsCode(db.provisionClientDatabase(f.maintenanceUrl, { ...f.input, jobId: randomUUID() }), "DATABASE_PROVISION_CONFLICT");
  assert.equal((await f.admin`SELECT rolpassword FROM pg_authid WHERE rolname=${f.names.role}`)[0].rolpassword, before.rolpassword);
  assert.equal((await sql`SELECT brand_name FROM clients`)[0].brand_name, "Preserved fixture");
  assert.equal((await db.initializeFreshDatabase(f.databaseUrl, await loadBaseline(), client)).reused, true);
});

test("occupied role or database is refused without adoption or removal", async (t) => {
  const f = await databaseProvisionFixture(t);
  await f.admin.begin(async (tx) => {
    await tx.unsafe(`CREATE ROLE "${f.names.role}" NOLOGIN`);
    await tx.unsafe(`COMMENT ON ROLE "${f.names.role}" IS '${f.fixtureMarker}'`);
  });
  await rejectsCode(db.provisionClientDatabase(f.maintenanceUrl, f.input), "DATABASE_PROVISION_CONFLICT");
  assert.equal((await f.admin`SELECT rolcanlogin FROM pg_roles WHERE rolname=${f.names.role}`)[0].rolcanlogin, false);
  await f.admin.unsafe(`CREATE DATABASE "${f.names.database}"`);
  await f.admin.unsafe(`COMMENT ON DATABASE "${f.names.database}" IS '${f.fixtureMarker}'`);
  await rejectsCode(db.provisionClientDatabase(f.maintenanceUrl, f.input), "DATABASE_PROVISION_CONFLICT");
  assert.equal((await f.admin`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=${f.names.database}`)[0].marker, f.fixtureMarker);
});

test("provision lock prevents concurrent modifications and a pending empty owned database can finish safely", async (t) => {
  const f = await databaseProvisionFixture(t);
  await f.admin`SELECT pg_advisory_lock(hashtextextended(${`lms-core-db-v1:${f.input.clientId}`},0))`;
  try { await rejectsCode(db.provisionClientDatabase(f.maintenanceUrl, f.input), "DATABASE_PROVISION_BUSY"); }
  finally { await f.admin`SELECT pg_advisory_unlock(hashtextextended(${`lms-core-db-v1:${f.input.clientId}`},0))`; }
  assert.equal((await f.admin`SELECT count(*)::int AS count FROM pg_roles WHERE rolname=${f.names.role}`)[0].count, 0);
  await db.provisionClientDatabase(f.maintenanceUrl, f.input);
  await f.admin.unsafe(`COMMENT ON DATABASE "${f.names.database}" IS '${f.marker}:pending'`);
  assert.equal((await db.provisionClientDatabase(f.maintenanceUrl, f.input)).reused, false);
  await f.admin.unsafe(`COMMENT ON DATABASE "${f.names.database}" IS '${f.marker}:pending'`);
  await f.connect(f.databaseUrl).unsafe("CREATE TABLE fixture_occupied (value integer)");
  await assert.rejects(db.provisionClientDatabase(f.maintenanceUrl, f.input), (error) => error.code === "DATABASE_PROVISION_CONFLICT" && error.requiresAttention === true);
});

test("restricted-role check rejects admin credentials, membership and unexpected public access", async (t) => {
  const f = await databaseProvisionFixture(t);
  await db.provisionClientDatabase(f.maintenanceUrl, f.input);
  const adminOnTenant = new URL(f.maintenanceUrl); adminOnTenant.pathname = `/${f.names.database}`;
  await rejectsCode(db.assertRestrictedDatabaseRole(adminOnTenant.href, f.input.clientId), "DATABASE_ROLE_NOT_RESTRICTED");
  await f.admin.unsafe(`GRANT pg_read_all_data TO "${f.names.role}"`);
  await rejectsCode(db.assertRestrictedDatabaseRole(f.databaseUrl, f.input.clientId), "DATABASE_ROLE_NOT_RESTRICTED");
  await f.admin.unsafe(`REVOKE pg_read_all_data FROM "${f.names.role}"`);
  await f.admin.unsafe(`GRANT CONNECT ON DATABASE "${f.names.database}" TO PUBLIC`);
  await rejectsCode(db.assertRestrictedDatabaseRole(f.databaseUrl, f.input.clientId), "DATABASE_OWNERSHIP_MISMATCH");
  await rejectsCode(db.provisionClientDatabase(f.maintenanceUrl, f.input), "DATABASE_OWNERSHIP_MISMATCH");
});

test("one provisioned client cannot connect to another Core-owned database", async (t) => {
  const left = await databaseProvisionFixture(t), right = await databaseProvisionFixture(t);
  await db.provisionClientDatabase(left.maintenanceUrl, left.input);
  await db.provisionClientDatabase(right.maintenanceUrl, right.input);
  const other = new URL(left.databaseUrl); other.pathname = `/${right.names.database}`;
  await assert.rejects(left.connect(other.href).unsafe("SELECT 1"), (error) => error.code === "42501");
});
