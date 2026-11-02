const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadBaseline, testDatabase, fixtureClient, db } = require("./fresh-install-test-helper.cjs");
const { initializeFreshDatabase, normalizeFreshClient, verifyFreshSchema, freshSchemaShape, contentSha256 } = db;

test("fresh initialization validates public configuration and baseline before connecting", async () => {
  const client = fixtureClient();
  for (const invalid of [{ ...client, password: "not-a-public-field" }, { ...client, id: "invalid" }, { ...client, tariff: "invented" }, { ...client, maxAdmins: 0 }, { ...client, slug: "../other" }]) {
    assert.throws(() => normalizeFreshClient(invalid), (error) => error.code === "INVALID_CLIENT_CONFIG");
  }
  const baseline = await loadBaseline();
  await assert.rejects(initializeFreshDatabase("not-a-connection", { ...baseline, sha256: "0".repeat(64) }, client), (error) => error.code === "BASELINE_MISMATCH");
  await assert.rejects(initializeFreshDatabase("", baseline, client), (error) => error.code === "INVALID_DATABASE_CONFIG");
});

test("full baseline initializes once under a concurrent start and preserves existing installation data", { timeout: 60000 }, async (t) => {
  const { sql, databaseUrl } = await testDatabase(t, "baseline");
  const baseline = await loadBaseline();
  const client = fixtureClient();
  const results = await Promise.all([initializeFreshDatabase(databaseUrl, baseline, client), initializeFreshDatabase(databaseUrl, baseline, client)]);
  assert.deepEqual(results.map((result) => result.reused).sort(), [false, true]);
  await verifyFreshSchema(sql, true);
  assert.equal(freshSchemaShape().length, 22);
  const [counts] = await sql`SELECT (SELECT count(*)::int FROM clients) AS clients, (SELECT count(*)::int FROM roles) AS roles, (SELECT count(*)::int FROM users) AS users`;
  assert.deepEqual({ ...counts }, { clients: 1, roles: 3, users: 0 });
  await sql`UPDATE clients SET brand_name='Edited after install' WHERE id=${client.id}`;
  assert.equal((await initializeFreshDatabase(databaseUrl, baseline, client)).reused, true);
  assert.equal((await sql`SELECT brand_name FROM clients WHERE id=${client.id}`)[0].brand_name, "Edited after install");
  for (const changed of [{ ...client, id: randomUUID() }, { ...client, brandName: "Different original configuration" }]) {
    await assert.rejects(initializeFreshDatabase(databaseUrl, baseline, changed), (error) => error.code === "INSTALLATION_MISMATCH");
  }
  await assert.rejects(sql`INSERT INTO lms_runtime_values (client_id,storage_key,revision,is_deleted) VALUES (${client.id},'negative',-1,true)`, (error) => error.code === "23514");
  await assert.rejects(sql`INSERT INTO lms_runtime_values (client_id,storage_key,revision,is_deleted) VALUES (${randomUUID()},'foreign',1,true)`, (error) => error.code === "23503");
  await assert.rejects(sql`INSERT INTO lms_runtime_values (client_id,storage_key,revision,is_deleted) VALUES (${client.id},'no-payload',1,false)`, (error) => error.code === "23514");
});

test("fresh installer refuses another application's nonempty database without modifying it", async (t) => {
  const { sql, databaseUrl } = await testDatabase(t, "baseline");
  await sql.unsafe("CREATE FUNCTION fixture_existing_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
  await assert.rejects(initializeFreshDatabase(databaseUrl, await loadBaseline(), fixtureClient()), (error) => error.code === "DATABASE_NOT_EMPTY");
  assert.equal((await sql`SELECT fixture_existing_function() AS value`)[0].value, 1);
  await sql`CREATE TABLE foreign_data (value text NOT NULL)`;
  await sql`INSERT INTO foreign_data VALUES ('keep-this-fixture')`;
  await assert.rejects(initializeFreshDatabase(databaseUrl, await loadBaseline(), fixtureClient()), (error) => error.code === "DATABASE_NOT_EMPTY");
  assert.equal((await sql`SELECT value FROM foreign_data`)[0].value, "keep-this-fixture");
  assert.equal((await sql`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'`)[0].count, 1);
});

test("schema creation is rolled back completely when a SQL step fails", async (t) => {
  const { sql, databaseUrl } = await testDatabase(t, "baseline");
  const baseline = await loadBaseline();
  const broken = `${baseline.sql}\nSELECT * FROM deliberately_missing_fixture_table;`;
  await assert.rejects(initializeFreshDatabase(databaseUrl, { ...baseline, sql: broken, sha256: contentSha256(broken) }, fixtureClient()), (error) => error.code === "DATABASE_INITIALIZATION_FAILED");
  assert.equal((await sql`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'`)[0].count, 0);
});

test("an installation marker cannot hide a missing or structurally changed table", async (t) => {
  const { sql, databaseUrl } = await testDatabase(t, "baseline");
  const baseline = await loadBaseline();
  const client = fixtureClient();
  await initializeFreshDatabase(databaseUrl, baseline, client);
  await sql`ALTER TABLE courses ADD COLUMN unexpected_fixture text`;
  await assert.rejects(initializeFreshDatabase(databaseUrl, baseline, client), (error) => error.code === "SCHEMA_MISMATCH");
  assert.equal((await sql`SELECT count(*)::int AS count FROM clients`)[0].count, 1);
});
