const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { root, dbRequire } = require("./runtime-test-helper.cjs");
const db = require("../../../packages/db/dist/src/index.js");

async function databaseProvisionFixture(t, clientId = randomUUID()) {
  const config = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8"));
  const maintenance = new URL(process.env.CORE_DESKTOP_MODE === "1" ? process.env.DATABASE_URL : config.environment.DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(maintenance.hostname));
  assert.equal(maintenance.port, String(config.services.find(service => service.id === "postgres")?.port || 55432)); maintenance.pathname = "/postgres";
  assert.match(clientId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  const input = { clientId, jobId: randomUUID(), password: randomBytes(32).toString("base64url") };
  const names = db.clientDatabaseNames(input.clientId);
  const marker = `lms-core-db-v1:${input.clientId}:${input.jobId}`;
  const fixtureMarker = `core-provision-test:${input.jobId}`;
  const postgres = dbRequire("postgres");
  const admin = postgres(maintenance.href, { max: 1, onnotice: () => {} });
  const pools = [];
  const connect = (url) => { const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} }); pools.push(sql); return sql; };
  t.after(async () => {
    try {
      for (const pool of pools) await pool.end({ timeout: 5 });
      assert.deepEqual(db.clientDatabaseNames(input.clientId), names);
      const [database] = await admin`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=${names.database}`;
      if (database) {
        assert.ok([`${marker}:ready`, `${marker}:pending`, fixtureMarker].includes(database.marker), "Refusing to clean an unowned database");
        await admin.unsafe(`DROP DATABASE "${names.database}" WITH (FORCE)`);
      }
      const [role] = await admin`SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=${names.role}`;
      if (role) {
        assert.ok([marker, fixtureMarker].includes(role.marker), "Refusing to clean an unowned role");
        await admin.unsafe(`DROP ROLE "${names.role}"`);
      }
    } finally { await admin.end({ timeout: 5 }); }
  });
  return { db, admin, input, names, marker, fixtureMarker, connect, maintenanceUrl: maintenance.href,
    databaseUrl: db.clientDatabaseUrl(maintenance.href, input.clientId, input.password) };
}
module.exports = { databaseProvisionFixture, db };
