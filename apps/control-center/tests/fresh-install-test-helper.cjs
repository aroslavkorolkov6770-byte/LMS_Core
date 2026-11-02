const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { root, dbRequire } = require("./runtime-test-helper.cjs");
const db = require("../../../packages/db/dist/src/index.js");

async function loadBaseline() {
  const sql = await fs.readFile(path.join(root, "packages/db/install-baseline/0000_core_runtime_v1.sql"), "utf8");
  const spec = JSON.parse(await fs.readFile(path.join(root, "packages/db/install-baseline/baseline-spec.json"), "utf8"));
  assert.equal(spec.sqlFile, "0000_core_runtime_v1.sql");
  return { sql, version: spec.version, sha256: spec.sha256, schemaSha256: spec.schemaSha256 };
}

async function testDatabase(t, label) {
  assert.ok(["baseline", "bundle", "lms"].includes(label));
  const config = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8"));
  const url = new URL(process.env.CORE_DESKTOP_MODE === "1" ? process.env.DATABASE_URL : config.environment.DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.port, String(config.services.find(service => service.id === "postgres")?.port || 55432));
  const name = `core_${label}_test_${randomBytes(8).toString("hex")}`;
  assert.match(name, /^core_(?:baseline|bundle|lms)_test_[a-f0-9]{16}$/);
  const maintenance = new URL(url); maintenance.pathname = "/postgres";
  const postgres = dbRequire("postgres");
  const admin = postgres(maintenance.href, { max: 1, onnotice: () => {} });
  let sql;
  let created = false;
  t.after(async () => {
    try {
      if (sql) await sql.end({ timeout: 5 });
      if (created) {
        assert.match(name, /^core_(?:baseline|bundle|lms)_test_[a-f0-9]{16}$/);
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    } finally { await admin.end({ timeout: 5 }); }
  });
  await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
  url.pathname = `/${name}`;
  sql = postgres(url.href, { max: 1, onnotice: () => {} });
  return { sql, databaseUrl: url.href };
}

const fixtureClient = () => ({ id: randomUUID(), name: "Installation fixture", slug: "installation-fixture", domain: "fixture.invalid", brandName: "Fixture", tariff: "base", industryTemplate: "coffee_shop" });
module.exports = { loadBaseline, testDatabase, fixtureClient, db };
