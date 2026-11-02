"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const store = require("../scripts/core-client-delete.cjs");
const root = path.resolve(__dirname, "../..");

async function acceptance() {
  const config = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8"));
  let secrets = {};
  try { secrets = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-secrets.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const url = new URL({ ...config.environment, ...secrets }.DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname)); assert.equal(url.port, "55432");
  const postgres = createRequire(path.join(root, "packages/db/package.json"))("postgres");
  const id = crypto.randomUUID(), name = "core_delete_accept_" + id.replaceAll("-", "");
  url.pathname = "/postgres"; const admin = postgres(url.href, { max: 1, onnotice: () => {} });
  let sql, created = false, checks = 0;
  const a = crypto.randomUUID(), b = crypto.randomUUID(), userA = crypto.randomUUID(), userB = crypto.randomUUID();
  try {
    const [identity] = await admin.unsafe("SELECT current_setting('data_directory') AS directory");
    assert.equal(path.resolve(identity.directory).toLowerCase(), path.resolve(root, "infra/local-postgres/data").toLowerCase());
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await admin.unsafe(`COMMENT ON DATABASE "${name}" IS 'lms-core-delete-test:${id}'`);
    url.pathname = "/" + name; sql = postgres(url.href, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE TABLE clients(id uuid PRIMARY KEY,name text); CREATE TABLE users(id uuid PRIMARY KEY,client_id uuid REFERENCES clients ON DELETE CASCADE); CREATE TABLE documents(id uuid PRIMARY KEY,client_id uuid); CREATE TABLE tests(id uuid PRIMARY KEY,client_id uuid); CREATE TABLE roles(id int PRIMARY KEY,name text); CREATE TABLE progress(id uuid PRIMARY KEY,client_id uuid REFERENCES clients ON DELETE CASCADE,user_id uuid REFERENCES users ON DELETE SET NULL);`);
    await sql.unsafe("INSERT INTO clients VALUES($1,'remove fixture'),($2,'retain fixture')", [a, b]);
    await sql.unsafe("INSERT INTO users VALUES($1,$2),($3,$4)", [userA, a, userB, b]);
    for (const table of ["documents", "tests"]) await sql.unsafe(`INSERT INTO ${table} VALUES($1,$2),($3,$4)`, [crypto.randomUUID(), a, crypto.randomUUID(), b]);
    await sql.unsafe("INSERT INTO roles VALUES(1,'global role');");
    const initial = await store.clientSnapshot(sql, a);
    const input = { clientId: a, operationId: crypto.randomUUID(), snapshotHash: initial.hash, proof: { databaseDeleted: true } };
    let archived;
    const archive = async value => { archived = value; return "isolated-encrypted-archive-fixture"; };
    await assert.rejects(store.finalizeClientDeletion(sql, { ...input, proof: {} }, archive), /DATABASE_REQUIRED/); checks++;
    await assert.rejects(store.finalizeClientDeletion(sql, { ...input, snapshotHash: "a".repeat(64) }, archive), /Карточка изменилась/); checks++;
    await assert.rejects(store.finalizeClientDeletion(sql, input, async () => { throw Error("disk unavailable"); }), /disk unavailable/);
    assert.equal((await sql.unsafe("SELECT count(*)::int AS n FROM clients"))[0].n, 2); checks++;
    // A bad cross-client reference must roll back instead of editing another client's data.
    const progress = crypto.randomUUID();
    await sql.unsafe("INSERT INTO progress VALUES($1,$2,$3)", [progress, b, userA]);
    await assert.rejects(store.finalizeClientDeletion(sql, input, archive), /OTHER_CLIENT_CHANGED_ROLLBACK/);
    assert.equal((await sql.unsafe("SELECT user_id FROM progress WHERE id=$1", [progress]))[0].user_id, userA); checks++;
    await sql.unsafe("DELETE FROM progress WHERE id=$1", [progress]);
    assert.equal((await store.finalizeClientDeletion(sql, input, archive)).phase, "deleted"); checks++;
    for (const table of ["clients", "users", "documents", "tests"]) assert.equal((await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n, 1);
    assert.equal((await sql.unsafe("SELECT name FROM clients"))[0].name, "retain fixture");
    assert.equal((await sql.unsafe("SELECT name FROM roles"))[0].name, "global role"); checks++;
    assert.equal(archived.rows.clients[0].id, a); assert.equal(archived.rows.users[0].id, userA); checks++;
    assert.equal((await sql.unsafe("SELECT client_id FROM core_control.client_deletions"))[0].client_id, a); checks++;
    assert.equal((await sql.unsafe("SELECT count(*)::int AS n FROM pg_constraint WHERE conname IN ('documents_client_delete_fk','tests_client_delete_fk')"))[0].n, 2); checks++;
    console.log(JSON.stringify({ accepted: true, checks, isolatedDatabase: name, otherClientPreserved: true, rollbackAccepted: true, legacyForeignKeysRepaired: true, durableAudit: true }));
  } finally {
    if (sql) await sql.end({ timeout: 5 });
    if (created) {
      const [state] = await admin.unsafe("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name]);
      assert.equal(state.marker, "lms-core-delete-test:" + id); assert.ok(/^core_delete_accept_[a-f0-9]{32}$/.test(name));
      await admin.unsafe(`DROP DATABASE "${name}"`);
    }
    await admin.end({ timeout: 5 });
  }
}
void acceptance().catch(e => { console.error(e.message); process.exitCode = 1; });
