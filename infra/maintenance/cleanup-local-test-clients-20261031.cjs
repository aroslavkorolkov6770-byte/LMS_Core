"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const KEEP = "85818306-60cb-4edf-91cf-1fbeedc6f5e5";
const KEEP_NAME = "\u0420\u0443\u0441\u043b\u0430\u043d";
const TEMPORARY = ["5c5d9a43-af96-4f17-b0fb-73ae17063e7f", "ffe5afda-f49c-4518-9dea-429dca1dbf1e", "b89cc922-c63e-448c-bbe5-f696a5197948", "7ed3a4d8-501c-48d8-8ed6-ef924912a452"];
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const demand = (value, code) => { if (!value) throw Object.assign(Error(code), { code }); };
const ident = name => { demand(/^[a-z_][a-z0-9_]*$/.test(name), "INVALID_IDENTIFIER"); return '"' + name + '"'; };

function validateClients(clients) {
  demand(clients.filter(client => client.id === KEEP && client.name === KEEP_NAME).length === 1 && clients.filter(client => client.name === KEEP_NAME).length === 1, "RUSLAN_IDENTITY_NOT_CONFIRMED");
  demand(clients.every(client => client.id === KEEP || TEMPORARY.includes(client.id)), "UNEXPECTED_CLIENT_REFUSE_DELETE");
  return clients.filter(client => client.id !== KEEP).map(client => client.id).sort();
}
async function configuration() {
  const config = JSON.parse(await fs.readFile(path.join(ROOT, "apps/control-center/config/launcher-config.json"), "utf8"));
  let secrets = {};
  try { secrets = JSON.parse(await fs.readFile(path.join(ROOT, "apps/control-center/config/launcher-secrets.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const url = new URL({ ...config.environment, ...secrets }.DATABASE_URL);
  demand(process.platform === "win32" && ["postgres:", "postgresql:"].includes(url.protocol) && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "55432" && url.pathname === "/lms_core", "NOT_PRIVATE_LOCAL_CORE");
  const environment = { ...process.env, PGHOST: url.hostname, PGPORT: "55432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: "lms_core", PGCONNECT_TIMEOUT: "5", PGCLIENTENCODING: "UTF8" };
  delete environment.PGOPTIONS;
  const maintenance = new URL(url.href); maintenance.pathname = "/postgres";
  return { url, maintenance, environment, postgres: createRequire(path.join(ROOT, "packages/db/package.json"))("postgres") };
}
async function identity(sql, name) {
  const [row] = await sql`select current_database() as database, inet_server_port() as port, current_setting('data_directory') as directory`;
  demand(row.database === name && row.port === 55432 && path.resolve(row.directory).toLowerCase() === path.resolve(ROOT, "infra/local-postgres/data").toLowerCase(), "CLUSTER_IDENTITY_MISMATCH");
}
async function tables(sql) {
  const rows = await sql`select c.relname as name,exists(select 1 from information_schema.columns a where a.table_schema='public' and a.table_name=c.relname and a.column_name='client_id') as scoped from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname`;
  demand(rows.length >= 10 && rows.some(row => row.name === "clients") && rows.some(row => row.name === "users"), "UNEXPECTED_CORE_SCHEMA");
  return rows;
}
async function snapshot(sql, list, keptOnly) {
  const result = {};
  for (const table of list) {
    const condition = keptOnly ? table.name === "clients" ? "where id=$1::uuid" : table.scoped ? "where client_id=$1::uuid" : "" : "";
    const [row] = await sql.unsafe(`select count(*)::int as rows, coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text as contents from public.${ident(table.name)} t ${condition}`, condition ? [KEEP] : []);
    result[table.name] = { rows: row.rows, sha256: sha(Buffer.from(row.contents)) };
  }
  return result;
}
async function privateDirectory(directory) {
  const base = path.resolve(ROOT, "infra/backups/local-test-cleanup-20261031");
  demand(path.dirname(directory) === base && /^[a-f0-9-]{36}$/.test(path.basename(directory)), "UNSAFE_BACKUP_DIRECTORY");
  await fs.mkdir(directory, { recursive: true });
  for (let current = directory; current !== ROOT; current = path.dirname(current)) demand(!(await fs.lstat(current)).isSymbolicLink(), "BACKUP_PATH_IS_LINK");
  const who = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 10000 });
  const sid = /S-1-\d+(?:-\d+)+/.exec(who.stdout)?.[0]; demand(sid, "WINDOWS_OWNER_SID_MISSING");
  await run("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true, timeout: 10000 });
}
async function archiveFiles(directory, ids) {
  const folders = ["new-installations", "new-deployments", "ip-publications", "server-preparations", "memory-preparations", "ai-configuration", "mail-configuration", "uninstallations"];
  const roots = folders.map(folder => ({ base: path.resolve(ROOT, "infra/runtime", folder), label: folder }));
  const name = JSON.parse(await fs.readFile(path.join(ROOT, "apps/control-center/package.json"), "utf8")).name;
  demand(name === "@lms-core/control-center" && process.env.APPDATA, "CORE_PROFILE_LOCATION_UNCONFIRMED");
  roots.push({ base: path.resolve(process.env.APPDATA, "@lms-core/control-center/client-servers"), label: "client-servers" });
  const archived = [];
  for (const location of roots) for (const id of ids) {
    const source = path.join(location.base, id + ".json");
    demand(id !== KEEP && TEMPORARY.includes(id) && path.dirname(source) === location.base, "UNSAFE_ARTIFACT_SOURCE");
    try {
      const stat = await fs.lstat(source);
      demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 2 * 1024 ** 2, "UNSAFE_ARTIFACT_FILE");
      const bytes = await fs.readFile(source), value = JSON.parse(bytes.toString("utf8"));
      demand(value.clientId === id || value.client?.id === id, "ARTIFACT_CLIENT_MISMATCH");
      const destination = path.join(directory, "client-artifacts", location.label, id + ".json");
      demand(path.resolve(destination).startsWith(directory + path.sep), "UNSAFE_ARTIFACT_BACKUP");
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination, require("node:fs").constants.COPYFILE_EXCL);
      demand(sha(await fs.readFile(destination)) === sha(bytes) && sha(await fs.readFile(source)) === sha(bytes), "ARTIFACT_CHANGED_DURING_ARCHIVE");
      await fs.unlink(source); archived.push({ clientId: id, category: location.label, sha256: sha(bytes) });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return archived;
}

async function cleanup(apply) {
  const config = await configuration(), sql = config.postgres(config.url.href, { max: 1, onnotice: () => {} });
  const admin = config.postgres(config.maintenance.href, { max: 1, onnotice: () => {} });
  let session, transaction = false, committed = false, verification, verificationCreated = false;
  const operation = crypto.randomUUID(), verificationName = "core_cleanup_verify_" + operation.replaceAll("-", "");
  const directory = path.resolve(ROOT, "infra/backups/local-test-cleanup-20261031", operation), dump = path.join(directory, "core-before.dump");
  const tools = path.join(process.env.ProgramFiles || "C:\\Program Files", "PostgreSQL/18/bin");
  const report = { operation, scope: "local_core_only", phase: "inspection", keepClientId: KEEP, backupDirectory: directory, hostChanges: false };
  try {
    await identity(sql, "lms_core");
    const clients = await sql`select id,name from public.clients order by id`, ids = validateClients(clients);
    report.removedClientIds = ids;
    if (!apply || !ids.length) { report.phase = ids.length ? "dry_run" : "already_clean"; return report; }
    demand(ids.length === TEMPORARY.length, "CLIENT_SET_CHANGED_REVIEW_FIRST");
    await privateDirectory(directory);
    session = await sql.reserve(); await session.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ"); transaction = true;
    await session.unsafe("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    const list = await tables(session);
    // Hold out concurrent API writes while exporting a snapshot and checking cascade effects.
    await session.unsafe("LOCK TABLE " + list.map(table => "public." + ident(table.name)).join(",") + " IN SHARE ROW EXCLUSIVE MODE");
    demand(JSON.stringify(validateClients(await session`select id,name from public.clients order by id`)) === JSON.stringify(ids), "CLIENT_SET_CHANGED_REVIEW_FIRST");
    const before = await snapshot(session, list, false), retained = await snapshot(session, list, true);
    demand(retained.users.rows === 2, "RUSLAN_ADMIN_SET_CHANGED_REVIEW_FIRST");
    const [{ id: snapshotId }] = await session`select pg_export_snapshot() as id`;
    await run(path.join(tools, "pg_dump.exe"), ["-w", "--format=custom", "--no-owner", "--no-acl", "--snapshot=" + snapshotId, "--file", dump], { windowsHide: true, env: config.environment, timeout: 120000, maxBuffer: 1024 * 1024 });
    demand((await fs.stat(dump)).size > 0, "EMPTY_DATABASE_BACKUP");
    await run(path.join(tools, "pg_restore.exe"), ["--list", dump], { windowsHide: true, env: config.environment, timeout: 30000, maxBuffer: 1024 * 1024 });
    demand(/^core_cleanup_verify_[a-f0-9]{32}$/.test(verificationName), "UNSAFE_VERIFICATION_DATABASE");
    await identity(admin, "postgres");
    await admin.unsafe(`CREATE DATABASE ${ident(verificationName)} TEMPLATE template0`); verificationCreated = true;
    await admin.unsafe(`COMMENT ON DATABASE ${ident(verificationName)} IS 'lms-core-local-cleanup:${operation}'`);
    await run(path.join(tools, "pg_restore.exe"), ["-w", "--exit-on-error", "--no-owner", "--no-acl", "--dbname", verificationName, dump], { windowsHide: true, env: config.environment, timeout: 120000, maxBuffer: 1024 * 1024 });
    const url = new URL(config.url.href); url.pathname = "/" + verificationName;
    verification = config.postgres(url.href, { max: 1, onnotice: () => {} }); await identity(verification, verificationName);
    demand(JSON.stringify(await snapshot(verification, list, false)) === JSON.stringify(before), "RESTORED_DATABASE_DIFFERS");
    await verification.end({ timeout: 5 }); verification = null;
    const [marker] = await admin`select shobj_description(oid,'pg_database') as marker from pg_database where datname=${verificationName}`;
    demand(marker?.marker === "lms-core-local-cleanup:" + operation, "VERIFICATION_DATABASE_OWNER_MISMATCH");
    await admin.unsafe(`DROP DATABASE ${ident(verificationName)}`); verificationCreated = false;
    report.backupVerifiedByRestore = true; report.backupSha256 = sha(await fs.readFile(dump));
    await fs.writeFile(path.join(directory, "before.json"), JSON.stringify({ ...report, clients, before, retained }, null, 2), { flag: "wx" });
    // The legacy local schema lacks client cascade constraints on these two tables.
    for (const table of ["documents", "tests"]) {
      demand(list.some(item => item.name === table && item.scoped), "LEGACY_TABLE_SCOPE_UNCONFIRMED");
      await session.unsafe(`delete from public.${ident(table)} where client_id=any($1::uuid[])`, [ids]);
    }
    const removed = await session`delete from public.clients where id=any(${ids}::uuid[]) returning id`;
    demand(removed.length === ids.length, "DELETE_COUNT_MISMATCH");
    demand(JSON.stringify(await snapshot(session, list, true)) === JSON.stringify(retained), "RUSLAN_OR_ROLES_CHANGED_ROLLBACK");
    for (const table of list.filter(table => table.scoped)) {
      const [row] = await session.unsafe(`select count(*)::int as rows from public.${ident(table.name)} where client_id<>$1::uuid`, [KEEP]);
      demand(row.rows === 0, "TEMPORARY_ROWS_REMAIN");
    }
    const after = await snapshot(session, list, false);
    report.deletedRows = Object.fromEntries(list.map(table => [table.name, before[table.name].rows - after[table.name].rows]));
    report.keptDataUnchanged = true;
    const details = JSON.stringify({ initiatedBy: "owner_request_via_codex", operation, removedClientIds: ids, deletedRows: report.deletedRows, backupVerifiedByRestore: true, vpsTouched: false });
    await session.unsafe("insert into public.audit_log(client_id,action,entity_type,entity_id,details) values($1::uuid,'core.local_test_cleanup','maintenance',$2,$3::jsonb)", [KEEP, operation, details]);
    await session.unsafe("COMMIT"); transaction = false; committed = true; session.release(); session = null;
    report.archivedArtifacts = await archiveFiles(directory, ids);
    await sql.unsafe("VACUUM (ANALYZE)");
    const remaining = await sql`select id,name from public.clients order by id`;
    demand(remaining.length === 1 && remaining[0].id === KEEP && (await sql`select count(*)::int as rows from public.users`)[0].rows === 2, "FINAL_STATE_CHANGED");
    report.phase = "completed"; report.remainingClients = 1; report.remainingUsers = 2; report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(report, null, 2), { flag: "wx" });
    return report;
  } catch (error) {
    if (transaction && session) try { await session.unsafe("ROLLBACK"); } catch { /* Do not hide the original failure. */ }
    report.phase = committed ? "database_cleaned_needs_file_review" : "not_committed"; report.errorCode = /^[A-Z_]{1,100}$/.test(error.code || "") ? error.code : "LOCAL_CLEANUP_FAILED";
    try { if ((await fs.stat(directory)).isDirectory()) await fs.writeFile(path.join(directory, "failure.json"), JSON.stringify(report, null, 2)); } catch { /* No plaintext driver errors or data are logged. */ }
    throw Object.assign(Error(report.errorCode), { report });
  } finally {
    session?.release();
    if (verification) await verification.end({ timeout: 5 });
    if (verificationCreated) {
      const [row] = await admin`select shobj_description(oid,'pg_database') as marker from pg_database where datname=${verificationName}`;
      demand(row?.marker === "lms-core-local-cleanup:" + operation, "VERIFICATION_DATABASE_CLEANUP_REFUSED");
      await admin.unsafe(`DROP DATABASE ${ident(verificationName)}`);
    }
    await sql.end({ timeout: 5 }); await admin.end({ timeout: 5 }); delete config.environment.PGPASSWORD;
  }
}
module.exports = { validateClients, KEEP, TEMPORARY };
if (require.main === module) void cleanup(process.argv.includes("--apply")).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(JSON.stringify(error.report || { phase: "not_started", errorCode: "LOCAL_CLEANUP_FAILED" })); process.exitCode = 1; });
