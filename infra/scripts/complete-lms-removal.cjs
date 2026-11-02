"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createReadStream } = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const demand = (ok, code) => { if (!ok) throw Object.assign(Error(code), { code }); };
async function command(file, args, settings = {}) {
  try { return (await promisify(execFile)(file, args, { timeout: 30000, maxBuffer: 256 * 1024, env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, ...settings })).stdout; }
  catch (error) { throw Object.assign(Error("FULL_REMOVAL_COMMAND_FAILED"), { code: "FULL_REMOVAL_COMMAND_FAILED", exitCode: error.code }); }
}
async function checksum(file) { const h = crypto.createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); }

async function context(input, options) {
  const c = options.archive.validateRemoval(input);
  options.database.names(c);
  demand(options.fixture || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const disk = file => options.root ? path.join(options.root, file) : file, run = options.run || command;
  const directory = async file => {
    if (options.root && path.resolve(file) === path.resolve(options.root)) return;
    if (path.dirname(file) !== file) await directory(path.dirname(file));
    const stat = await fs.lstat(file);
    demand(stat.isDirectory() && !stat.isSymbolicLink() && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)), "FULL_REMOVAL_PATH_UNSAFE");
  };
  const read = async file => {
    await directory(path.dirname(file)); const stat = await fs.lstat(file);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 65536 && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)), "FULL_REMOVAL_FILE_UNSAFE");
    return fs.readFile(file, "utf8");
  };
  const optional = async file => { try { return await fs.lstat(file); } catch (e) { if (e.code !== "ENOENT") throw e; return null; } };
  const backupPath = `/srv/lms-core/backups/${c.clientId}/${c.operationId}`;
  const archived = options.archived === true;
  const application = disk(archived ? backupPath + "/application" : c.appPath);
  await directory(application);
  const owner = JSON.parse(await read(path.join(application, ".core-install-owner.json")));
  const runtime = JSON.parse(await read(path.join(application, "shared/runtime-context.json")));
  demand(owner.state === "installed" && owner.clientId === c.clientId && owner.jobId === c.jobId && owner.releaseId === c.releaseId && runtime.clientId === c.clientId && runtime.releaseId === c.releaseId && runtime.releaseRoot === `${c.appPath}/releases/${c.releaseId}`, "FULL_REMOVAL_OWNER_MISMATCH");
  let previous = null;
  const journal = disk(backupPath + "/full-removal.json");
  if (archived) {
    const receipt = JSON.parse(await read(disk(backupPath + "/receipt.json")));
    demand(["clientId", "jobId", "releaseId", "operationId", "appPath"].every(key => receipt[key] === c[key]) && receipt.phase === "uninstalled" && receipt.backupPath === backupPath, "FULL_REMOVAL_BACKUP_MISMATCH");
    const dump = disk(backupPath + "/database.dump"), stat = await optional(dump);
    demand(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === receipt.databaseDumpBytes && /^[a-f0-9]{64}$/.test(receipt.databaseDumpSha256) && await checksum(dump) === receipt.databaseDumpSha256, "FULL_REMOVAL_BACKUP_INVALID");
    for (const file of [c.appPath, `/etc/nginx/conf.d/lms-core-${c.clientId}.conf`, ...["api", "web"].map(role => `/etc/systemd/system/lms-${path.posix.basename(c.appPath)}-${role}.service`)]) demand(!await optional(disk(file)), "FULL_REMOVAL_INSTALLATION_PRESENT");
    try { previous = JSON.parse(await read(journal)); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (previous) demand(previous.version === 2 && ["clientId", "jobId", "releaseId", "operationId", "appPath"].every(key => previous[key] === c[key]) && previous.mode === "full" && previous.backupPath === backupPath, "FULL_REMOVAL_JOURNAL_MISMATCH");
  }
  const user = "lms-" + crypto.createHash("sha256").update(c.clientId).digest("hex").slice(0, 20);
  const account = async (requireStopped) => {
    const users = (await run("getent", ["passwd"])).trim().split("\n").map(line => line.split(":")), row = users.find(row => row[0] === user);
    if (!row) return null;
    demand(row[5] === c.appPath + "/shared/home" && row[6] === "/usr/sbin/nologin" && Number(row[2]) > 100 && Number(row[2]) < 65534 && users.filter(item => item[2] === row[2] || item[3] === row[3]).length === 1, "FULL_REMOVAL_ACCOUNT_MISMATCH");
    const groups = (await run("id", ["-G", user])).trim().split(/\s+/), group = (await run("getent", ["group", user])).trim().split(":");
    demand(groups.length === 1 && groups[0] === row[3] && group[0] === user && group[2] === row[3] && !group[3], "FULL_REMOVAL_ACCOUNT_SHARED");
    if (previous?.serviceUid !== undefined) demand(previous.serviceUid === Number(row[2]) && previous.serviceGid === Number(row[3]), "FULL_REMOVAL_ACCOUNT_CHANGED");
    if (requireStopped) try { demand(!(await run("ps", ["-u", row[2], "-o", "pid="])).trim(), "FULL_REMOVAL_ACCOUNT_BUSY"); } catch (e) { if (e.exitCode !== 1) throw e; }
    return { uid: Number(row[2]), gid: Number(row[3]) };
  };
  const tls = options.publication.tlsPaths(c), renewal = options.publication.renewalConfiguration(c);
  const assets = [{ key: "certificate", source: tls.base, destination: backupPath + "/https" }, { key: "webroot", source: tls.webroot, destination: backupPath + "/acme-webroot" }];
  const inspectAssets = async () => {
    for (const item of assets) {
      const source = await optional(disk(item.source)), destination = await optional(disk(item.destination));
      if (destination) { demand(archived && previous && !source, "FULL_REMOVAL_ARCHIVE_OCCUPIED"); await directory(disk(item.destination)); }
      if (!source) continue;
      await directory(disk(item.source));
      demand(source.dev === (await fs.stat(application)).dev, "FULL_REMOVAL_FILESYSTEM_DIFFERS");
      if (item.key === "certificate") demand(await read(disk(tls.base + "/reload-nginx.sh")) === renewal.files.find(([file]) => file === tls.base + "/reload-nginx.sh")[1], "FULL_REMOVAL_CERTIFICATE_OWNER_MISMATCH");
      let count = 0;
      const walk = async file => {
        demand(++count <= 10000, "FULL_REMOVAL_ASSET_LIMIT");
        const stat = await fs.lstat(file);
        demand(options.fixture || stat.uid === 0 && (stat.isSymbolicLink() || !(stat.mode & 0o022)), "FULL_REMOVAL_ASSET_UNSAFE");
        if (stat.isSymbolicLink()) { const resolved = await fs.realpath(file); demand(resolved.startsWith(disk(item.source) + path.sep), "FULL_REMOVAL_ASSET_LINK_UNSAFE"); }
        else if (stat.isDirectory()) for (const name of await fs.readdir(file)) await walk(path.join(file, name));
        else demand(stat.isFile() && stat.nlink === 1, "FULL_REMOVAL_ASSET_UNSAFE");
      };
      await walk(disk(item.source));
    }
  };
  await inspectAssets();
  return { c, disk, run, directory, read, optional, application, backupPath, previous, journal, user, account, assets };
}

async function inspectFullRemoval(input, options = {}) {
  const s = await context(input, options);
  await s.account(options.archived === true);
  if (options.archived && await s.optional(s.disk(s.backupPath + "/full-removal.lock"))) throw Object.assign(Error("FULL_REMOVAL_BUSY"), { code: "FULL_REMOVAL_BUSY" });
  let deletionJournal = null;
  if (options.archived) try { deletionJournal = JSON.parse(await s.read(s.disk(s.backupPath + "/client-deletion.json"))); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (deletionJournal) demand(["clientId", "jobId", "releaseId", "operationId"].every(key => deletionJournal[key] === input[key]) && deletionJournal.database === options.database.names(input).database && Number.isSafeInteger(deletionJournal.databaseOid) && deletionJournal.databaseOid > 0, "FULL_REMOVAL_DATABASE_JOURNAL_MISMATCH");
  else await options.database.checkClientDatabase(input, { ...options, archived: options.archived === true });
  return { ...s.c, phase: "checked", mode: "full", preserveData: false, database: options.database.names(input).database, archiveCompleted: options.archived === true, ...(options.archived ? { backupPath: s.backupPath } : {}) };
}

async function completeRemoval(input, options = {}) {
  demand(options.agreement === true, "FULL_REMOVAL_CONFIRMATION_REQUIRED");
  const s = await context(input, { ...options, archived: true });
  const lockFile = s.disk(s.backupPath + "/full-removal.lock"), lock = await fs.open(lockFile, "wx", 0o600);
  const state = { ...s.c, version: 2, mode: "full", preserveData: false, backupPath: s.backupPath, archiveCompleted: true, phase: "running", database: options.database.names(input).database, ...s.previous };
  const save = async () => { state.updatedAt = new Date().toISOString(); const tmp = s.journal + "." + crypto.randomUUID() + ".tmp"; await fs.writeFile(tmp, JSON.stringify(state), { flag: "wx", mode: 0o600 }); await fs.rename(tmp, s.journal); };
  try {
    await lock.writeFile(JSON.stringify({ operationId: input.operationId, pid: process.pid })); await lock.close();
    const account = await s.account(true);
    if (account) { state.serviceUid = account.uid; state.serviceGid = account.gid; }
    state.phase = "running"; state.step = "database"; await save();
    // The existing worker validates dump checksum, UUID markers and original SQL OID on every retry.
    const dropped = await options.database.deleteArchivedDatabase(input, { ...options, agreement: true, archived: true });
    demand(dropped.databaseDeleted === true, "FULL_REMOVAL_DATABASE_UNCONFIRMED"); state.databaseDeleted = true;
    state.step = "archive_https"; await save();
    for (const item of s.assets) if (await s.optional(s.disk(item.source))) { demand(!await s.optional(s.disk(item.destination)), "FULL_REMOVAL_ARCHIVE_OCCUPIED"); await fs.rename(s.disk(item.source), s.disk(item.destination)); }
    state.certificatesArchived = true; state.step = "service_account"; await save();
    // Root-owned backups must not expose retained files when the operating system reuses a deleted UID.
    await s.run("chown", ["-hR", "root:root", s.disk(s.backupPath)], { timeout: 300000 });
    if (await s.account(true)) await s.run("userdel", [s.user]);
    demand(!await s.account(false), "FULL_REMOVAL_ACCOUNT_STILL_PRESENT");
    let group = null;
    try { group = (await s.run("getent", ["group", s.user])).trim().split(":"); } catch (error) { if (![1, 2].includes(error.exitCode)) throw error; }
    if (group) {
      const users = (await s.run("getent", ["passwd"])).trim().split("\n").map(line => line.split(":"));
      demand(Number.isSafeInteger(state.serviceGid) && group[0] === s.user && Number(group[2]) === state.serviceGid && !group[3] && !users.some(row => Number(row[3]) === state.serviceGid), "FULL_REMOVAL_GROUP_SHARED");
      await s.run("groupdel", [s.user]);
    }
    state.serviceAccountDeleted = true; state.phase = "uninstalled"; state.step = "complete"; delete state.errorCode; await save();
    return state;
  } catch (error) {
    state.phase = "needs_attention"; state.errorCode = /^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "FULL_REMOVAL_INCOMPLETE";
    await save(); return state;
  } finally { try { await lock.close(); } catch {} await fs.unlink(lockFile).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
module.exports = { inspectFullRemoval, completeRemoval };
