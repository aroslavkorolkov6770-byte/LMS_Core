"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createReadStream } = require("node:fs");
const { execFile } = require("node:child_process");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const demand = (ok, code) => { if (!ok) throw Object.assign(Error(code), { code }); };

function names(input) {
  demand(input && ["clientId", "jobId", "releaseId", "operationId"].every(key => UUID.test(input[key])) &&
    /^\/srv\/lms-core\/clients\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.appPath), "CLIENT_DELETE_INPUT_INVALID");
  const suffix = input.clientId.replaceAll("-", "");
  return { database: `lms_${suffix}`, role: `lms_role_${suffix}`, marker: `lms-core-db-v1:${input.clientId}:${input.jobId}` };
}

// Every identifier comes from a UUID, never from an editable host/profile field.
function databaseSql(input, remove = false, previousOid = null) {
  const n = names(input);
  demand(previousOid === null || Number.isSafeInteger(previousOid) && previousOid > 0, "CLIENT_DELETE_OID_INVALID");
  return `SET statement_timeout='30s'; SET lock_timeout='10s';
SELECT pg_advisory_lock(hashtextextended('lms-core-db-v1:${input.clientId}',0));
DO $guard$
DECLARE d record; r record;
BEGIN
  IF current_database()<>'postgres' OR session_user<>'postgres' OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'MAINTENANCE_REQUIRED'; END IF;
  SELECT oid,datname,datdba,datistemplate,shobj_description(oid,'pg_database') AS marker INTO d FROM pg_database WHERE datname='${n.database}';
  SELECT oid,rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,shobj_description(oid,'pg_authid') AS marker INTO r FROM pg_roles WHERE rolname='${n.role}';
  IF d.oid IS NULL AND ${previousOid === null ? "TRUE" : "FALSE"} THEN RAISE EXCEPTION 'DATABASE_MISSING_WITHOUT_RECEIPT'; END IF;
  IF d.oid IS NOT NULL AND (r.oid IS NULL OR d.datdba<>r.oid OR d.datistemplate OR d.marker IS DISTINCT FROM '${n.marker}:ready'${previousOid === null ? "" : ` OR d.oid<>${previousOid}`}) THEN RAISE EXCEPTION 'DATABASE_OWNER_MISMATCH'; END IF;
  IF r.oid IS NOT NULL AND (r.marker IS DISTINCT FROM '${n.marker}' OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)) THEN RAISE EXCEPTION 'DATABASE_ROLE_MISMATCH'; END IF;
END $guard$;
${remove ? `SELECT format('ALTER DATABASE %I ALLOW_CONNECTIONS false',datname) FROM pg_database WHERE datname='${n.database}' \\gexec
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${n.database}' AND pid<>pg_backend_pid();
SELECT format('DROP DATABASE %I',datname) FROM pg_database WHERE datname='${n.database}' \\gexec
SELECT format('DROP ROLE %I',rolname) FROM pg_roles WHERE rolname='${n.role}' \\gexec` : ""}
SELECT json_build_object('database','${n.database}','oid',(SELECT oid::bigint FROM pg_database WHERE datname='${n.database}'),'databaseDeleted',NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='${n.database}'),'roleDeleted',NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${n.role}'));
SELECT pg_advisory_unlock(hashtextextended('lms-core-db-v1:${input.clientId}',0));
`;
}

async function executeSql(sql, port) {
  return new Promise((resolve, reject) => {
    const child = execFile("runuser", ["-u", "postgres", "--", "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "/var/run/postgresql", "-p", String(port), "-d", "postgres"],
      { timeout: 90000, maxBuffer: 65536, env: { PATH: process.env.PATH, LANG: "C.UTF-8", PGCONNECT_TIMEOUT: "10" } }, (error, stdout) => {
        if (error) reject(Object.assign(Error("CLIENT_DATABASE_DELETE_FAILED"), { code: "CLIENT_DATABASE_DELETE_FAILED" }));
        else try { resolve(JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('{"database"')) || "null")); }
        catch { reject(Object.assign(Error("CLIENT_DATABASE_RESULT_INVALID"), { code: "CLIENT_DATABASE_RESULT_INVALID" })); }
      });
    child.stdin.on("error", () => {}); child.stdin.end(sql);
  });
}
async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function context(input, options, archived) {
  const n = names(input);
  demand(options.fixture || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const disk = name => options.root ? path.join(options.root, name) : name;
  async function directory(file) {
    if (options.root && file === path.resolve(options.root)) return;
    if (path.dirname(file) !== file) await directory(path.dirname(file));
    const stat = await fs.lstat(file);
    demand(stat.isDirectory() && !stat.isSymbolicLink() && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)), "CLIENT_DELETE_PATH_UNSAFE");
  }
  async function read(file, max = 256 * 1024) {
    await directory(path.dirname(file));
    const stat = await fs.lstat(file);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)), "CLIENT_DELETE_FILE_UNSAFE");
    return fs.readFile(file);
  }
  const backupPath = `/srv/lms-core/backups/${input.clientId}/${input.operationId}`;
  const base = disk(archived ? backupPath + "/application" : input.appPath);
  const owner = JSON.parse((await read(path.join(base, ".core-install-owner.json"))).toString());
  const runtime = JSON.parse((await read(path.join(base, "shared/runtime-context.json"))).toString());
  demand(owner.state === "installed" && owner.clientId === input.clientId && owner.jobId === input.jobId && owner.releaseId === input.releaseId &&
    runtime.clientId === input.clientId && runtime.releaseId === input.releaseId && runtime.releaseRoot === `${input.appPath}/releases/${input.releaseId}`, "CLIENT_DELETE_OWNER_MISMATCH");
  const key = await read(path.join(base, "shared/runtime-vault.key"));
  demand(key.length === 32 && typeof options.unseal === "function", "CLIENT_DELETE_VAULT_INVALID");
  let secrets;
  try { secrets = options.unseal(JSON.parse((await read(path.join(base, "shared/runtime-vault.json"))).toString()), key, input.clientId); }
  finally { key.fill(0); }
  const url = new URL(secrets.databaseUrl); delete secrets.databaseUrl;
  demand(["postgres:", "postgresql:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.pathname === "/" + n.database && decodeURIComponent(url.username) === n.role, "CLIENT_DELETE_SEPARATE_DATABASE_UNSUPPORTED");
  const port = Number(url.port || 5432); url.password = "";
  demand(Number.isInteger(port) && port > 0 && port < 65536, "CLIENT_DELETE_PORT_INVALID");
  if (archived) {
    const receipt = JSON.parse((await read(disk(backupPath + "/receipt.json"))).toString());
    demand(["clientId", "jobId", "releaseId", "operationId", "appPath"].every(key => receipt[key] === input[key]) && receipt.phase === "uninstalled" && receipt.backupPath === backupPath && /^[a-f0-9]{64}$/.test(receipt.databaseDumpSha256), "CLIENT_DELETE_BACKUP_MISMATCH");
    const dump = disk(backupPath + "/database.dump"), stat = await fs.lstat(dump);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === receipt.databaseDumpBytes && (options.fixture || stat.uid === 0 && !(stat.mode & 0o077)) && await hashFile(dump) === receipt.databaseDumpSha256, "CLIENT_DELETE_BACKUP_INVALID");
    for (const file of [input.appPath, `/etc/nginx/conf.d/lms-core-${input.clientId}.conf`, ...["api", "web"].map(role => `/etc/systemd/system/lms-${path.posix.basename(input.appPath)}-${role}.service`)]) {
      try { await fs.lstat(disk(file)); demand(false, "CLIENT_DELETE_INSTALLATION_STILL_PRESENT"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return { n, port, backupPath, disk, read, execute: options.executeSql || executeSql };
}

async function checkClientDatabase(input, options = {}) {
  const s = await context(input, options, options.archived === true);
  const value = await s.execute(databaseSql(input), s.port);
  demand(value?.database === s.n.database && Number.isSafeInteger(Number(value.oid)) && Number(value.oid) > 0 && !value.databaseDeleted, "CLIENT_DELETE_DATABASE_UNCONFIRMED");
  return { database: s.n.database, oid: Number(value.oid), phase: "checked" };
}

async function deleteArchivedDatabase(input, options = {}) {
  demand(options.agreement === true, "CLIENT_DELETE_CONFIRMATION_REQUIRED");
  const s = await context(input, options, true), file = s.disk(s.backupPath + "/client-deletion.json");
  let previous = null;
  try {
    previous = JSON.parse((await s.read(file)).toString());
    demand(["clientId", "jobId", "releaseId", "operationId"].every(key => previous[key] === input[key]) && previous.database === s.n.database && Number.isSafeInteger(previous.databaseOid) && previous.databaseOid > 0, "CLIENT_DELETE_JOURNAL_MISMATCH");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const oid = previous?.databaseOid || (await checkClientDatabase(input, { ...options, archived: true })).oid;
  const state = { version: 1, clientId: input.clientId, jobId: input.jobId, releaseId: input.releaseId, operationId: input.operationId, database: s.n.database, databaseOid: oid, backupPath: s.backupPath, phase: "deleting", updatedAt: new Date().toISOString() };
  const save = async value => { const tmp = file + "." + crypto.randomUUID() + ".tmp"; await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await fs.rename(tmp, file); };
  await save(state);
  const result = await s.execute(databaseSql(input, true, oid), s.port);
  demand(result?.database === s.n.database && result.databaseDeleted === true && result.roleDeleted === true, "CLIENT_DELETE_DATABASE_UNCONFIRMED");
  const final = { ...state, phase: "database_deleted", databaseDeleted: true, updatedAt: new Date().toISOString() };
  await save(final); return final;
}
module.exports = { names, databaseSql, checkClientDatabase, deleteArchivedDatabase };
