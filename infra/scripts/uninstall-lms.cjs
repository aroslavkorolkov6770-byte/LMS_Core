"use strict";
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const demand = (value, code) => { if (!value) throw Object.assign(Error(code), { code }); };

function validateRemoval(value) {
  demand(value && ["clientId", "jobId", "releaseId", "operationId"].every(key => UUID.test(value[key])) &&
    /^\/srv\/lms-core\/clients\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.appPath) &&
    Number.isInteger(value.webPort) && value.webPort >= 3000 && value.webPort <= 3099 && typeof value.host === "string", "REMOVAL_INPUT_INVALID");
  return Object.fromEntries(["clientId", "jobId", "releaseId", "operationId", "appPath", "webPort", "host"].map(key => [key, value[key]]));
}

function expectedService(context, user, executable, role) {
  return `[Unit]\nDescription=LMS Core ${role}\nAfter=network-online.target\n[Service]\nType=simple\nUser=${user}\nGroup=${user}\nWorkingDirectory=${context.releaseRoot}\nExecStart=${executable} ${context.releaseRoot}/backend/runtime-process.cjs ${path.posix.dirname(path.posix.dirname(context.releaseRoot))}/shared/runtime-context.json ${role}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nUMask=0077\nTimeoutStopSec=20\n[Install]\nWantedBy=multi-user.target\n`;
}

async function command(file, args, settings = {}) {
  try { return (await promisify(execFile)(file, args, { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, ...settings })).stdout; }
  catch (error) { if (settings.allowInactive && [1, 3, 4].includes(error.code)) return String(error.stdout || ""); throw Object.assign(Error("REMOVAL_COMMAND_FAILED"), { code: "REMOVAL_COMMAND_FAILED" }); }
}
async function checksum(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function removalContext(value, options) {
  const c = validateRemoval(value);
  demand(options.fixture || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const disk = name => options.root ? path.join(options.root, name) : name;
  const run = options.run || command;
  const directory = async (name, create = false) => {
    if (options.root && name === path.resolve(options.root)) return;
    const parent = path.dirname(name); if (parent !== name) await directory(parent, create);
    if (create) try { await fs.mkdir(name, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await fs.lstat(name);
    demand(stat.isDirectory() && !stat.isSymbolicLink() && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)), "REMOVAL_PATH_UNSAFE");
  };
  const read = async name => {
    const stat = await fs.lstat(name);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 256 * 1024 && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)), "REMOVAL_FILE_UNSAFE");
    return fs.readFile(name, "utf8");
  };
  await directory(disk(c.appPath)); await directory(disk(c.appPath + "/shared"));
  const ownerText = await read(disk(c.appPath + "/.core-install-owner.json"));
  const contextText = await read(disk(c.appPath + "/shared/runtime-context.json"));
  const owner = JSON.parse(ownerText), context = JSON.parse(contextText);
  demand(owner.state === "installed" && owner.clientId === c.clientId && owner.jobId === c.jobId && owner.releaseId === c.releaseId &&
    context.clientId === c.clientId && context.releaseId === c.releaseId && context.webPort === c.webPort && context.releaseRoot === `${c.appPath}/releases/${c.releaseId}`, "REMOVAL_OWNER_MISMATCH");
  const current = disk(c.appPath + "/current"), release = disk(context.releaseRoot);
  await directory(path.dirname(release)); await directory(release);
  demand((await fs.lstat(current)).isSymbolicLink() && await fs.realpath(current) === await fs.realpath(release), "REMOVAL_RELEASE_MISMATCH");
  const user = "lms-" + crypto.createHash("sha256").update(c.clientId).digest("hex").slice(0, 20);
  const names = ["api", "web"].map(role => `lms-${path.posix.basename(c.appPath)}-${role}.service`);
  demand(JSON.stringify(owner.services) === JSON.stringify(names), "REMOVAL_SERVICE_MISMATCH");
  await directory(disk("/etc/systemd/system"));
  const files = [];
  for (const [index, name] of names.entries()) {
    const file = disk("/etc/systemd/system/" + name), body = await read(file);
    const executable = /^ExecStart=(\/[^ \r\n]+) /m.exec(body)?.[1];
    demand(executable && /^\/(?:[a-z0-9_.-]+\/)*node$/i.test(executable) && body === expectedService(context, user, executable, index === 0 ? "api" : "web"), "REMOVAL_SERVICE_MISMATCH");
    files.push({ file, body, kind: "unit", name });
  }
  demand(options.publication && options.unseal, "REMOVAL_DEPENDENCIES_REQUIRED");
  const publication = options.publication;
  // Tests may supply an isolated Nginx include directory; Core itself uses the fixed default.
  const nginx = options.nginxDirectory ? path.join(options.nginxDirectory, `lms-core-${c.clientId}.conf`) : disk(`/etc/nginx/conf.d/lms-core-${c.clientId}.conf`);
  try {
    await directory(path.dirname(nginx));
    const body = await read(nginx);
    demand([publication.nginxConfiguration(c), publication.nginxConfiguration(c, true), publication.nginxHttpsConfiguration(c)].includes(body), "REMOVAL_NGINX_CHANGED");
    files.push({ file: nginx, body, kind: "nginx", name: "nginx.conf" });
    await run("nginx", ["-t"]);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const renewal = publication.renewalConfiguration(c);
  for (const [name, expected] of renewal.files.filter(([name]) => name.startsWith("/etc/systemd/system/"))) {
    try {
      const file = disk(name), body = await read(file);
      demand(body === expected, "REMOVAL_RENEWAL_CHANGED");
      files.push({ file, body, kind: "renewal", name: path.posix.basename(name) });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const renewalNames = files.filter(file => file.kind === "renewal").map(file => file.name);
  demand(renewalNames.length === 0 || renewalNames.length === 2, "REMOVAL_RENEWAL_INCOMPLETE");
  const states = [];
  for (const name of [...names, ...renewalNames]) {
    const active = (await run("systemctl", ["is-active", name], { allowInactive: true })).trim();
    const enabled = (await run("systemctl", ["is-enabled", name], { allowInactive: true })).trim();
    demand(["active", "inactive", "failed"].includes(active) && ["enabled", "disabled", "static"].includes(enabled), "REMOVAL_SERVICE_STATE_UNSUPPORTED");
    states.push({ name, active: active === "active", enabled: enabled === "enabled" });
  }
  // Read only our sealed connection. The unsealed value is never part of a plan/receipt or stdout.
  const envelope = JSON.parse(await read(disk(c.appPath + "/shared/runtime-vault.json")));
  const keyFile = disk(c.appPath + "/shared/runtime-vault.key");
  const keyStat = await fs.lstat(keyFile);
  demand(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.nlink === 1 && keyStat.size === 32 && (options.fixture || keyStat.uid === 0 && !(keyStat.mode & 0o027)), "REMOVAL_VAULT_UNSAFE");
  const key = await fs.readFile(keyFile);
  let secrets;
  try { secrets = options.unseal(envelope, key, c.clientId); } finally { key.fill(0); }
  const database = new URL(secrets.databaseUrl);
  for (const key of Object.keys(secrets)) delete secrets[key];
  const suffix = c.clientId.replaceAll("-", "").toLowerCase();
  demand(["postgres:", "postgresql:"].includes(database.protocol) && decodeURIComponent(database.username) === `lms_role_${suffix}` && database.pathname === `/lms_${suffix}` && database.password && !database.hash &&
    [...database.searchParams.keys()].every(name => name === "sslmode") && database.searchParams.getAll("sslmode").length <= 1 &&
    (!database.searchParams.has("sslmode") || ["disable", "require", "verify-ca", "verify-full"].includes(database.searchParams.get("sslmode"))), "REMOVAL_DATABASE_MISMATCH");
  return { c, disk, run, directory, read, files, states, names, database, ownerText, contextText, release };
}

async function inspectRemoval(value, options = {}) {
  const state = await removalContext(value, options), c = state.c;
  // Checking tool availability/space is read-only; no dump and no service changes here.
  await backupBudget(state, options);
  state.database.password = "";
  return { clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, operationId: c.operationId, host: c.host, appPath: c.appPath,
    checkedAt: new Date().toISOString(), phase: "checked", preserveData: true, services: state.states.map(item => item.name), databasePreserved: true, filesPreserved: true };
}

async function backupBudget(state, options) {
  const dumpVersion = await state.run("pg_dump", ["--version"]), restoreVersion = await state.run("pg_restore", ["--version"]);
  const major = text => Number(/(?:PostgreSQL\)?\s*|pg_restore\s+)(\d+)/.exec(text)?.[1]);
  const database = new URL(state.database.href), password = decodeURIComponent(database.password); database.password = "";
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", PGCONNECT_TIMEOUT: "10", PGPASSWORD: password };
  let result;
  try { result = await state.run("psql", ["--no-psqlrc", "--no-align", "--tuples-only", "--dbname", database.href, "--command", "SELECT pg_database_size(current_database()), current_setting('server_version_num')"], { env, timeout: 30000 }); }
  finally { delete env.PGPASSWORD; }
  const match = /^(\d+)\|(\d+)\s*$/.exec(result.trim());
  demand(match && Number.isSafeInteger(Number(match[1])) && Number(match[2]) >= 100000 && major(dumpVersion) >= Math.floor(Number(match[2]) / 10000) && major(restoreVersion) >= major(dumpVersion), "REMOVAL_DATABASE_TOOL_VERSION_MISMATCH");
  const stats = await fs.statfs(state.disk(state.c.appPath));
  const required = options.minimumFreeBytes ?? Math.max(1024 ** 3, Math.ceil(Number(match[1]) * 1.2) + 256 * 1024 ** 2);
  demand(Number(stats.bavail) * Number(stats.bsize) >= required, "REMOVAL_BACKUP_DISK_REQUIRED");
}

async function uninstallLms(value, options = {}) {
  const s = await removalContext(value, options), { c, disk, run } = s;
  demand(options.agreement === true, "REMOVAL_CONFIRMATION_REQUIRED");
  const base = `/srv/lms-core/backups/${c.clientId}`, backupPath = `${base}/${c.operationId}`, backup = disk(backupPath), original = disk(c.appPath);
  await s.directory(disk(base), true);
  demand((await fs.stat(original)).dev === (await fs.stat(disk(base))).dev, "REMOVAL_BACKUP_FILESYSTEM_DIFFERS");
  await backupBudget(s, options);
  const publicationDir = disk(`/srv/lms-core/publications/${c.clientId}`);
  await s.directory(publicationDir, true);
  const locks = [], moved = [], stopped = [];
  let archived = false, journalCreated = false, step = "lock";
  const journal = { version: 1, clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, operationId: c.operationId, appPath: c.appPath, backupPath, phase: "preparing", step,
    preserveData: true, databasePreserved: true, filesPreserved: true, updatedAt: new Date().toISOString() };
  const record = async phase => {
    journal.phase = phase; journal.step = step; journal.updatedAt = new Date().toISOString();
    const temporary = path.join(backup, "receipt.tmp");
    await fs.writeFile(temporary, JSON.stringify(journal, null, 2), { mode: 0o600 });
    await fs.rename(temporary, path.join(backup, "receipt.json"));
  };
  try {
    for (const file of [path.join(original, "shared/ai-configuration.lock"), path.join(publicationDir, "publish.lock")]) {
      const handle = await fs.open(file, "wx", 0o600); locks.push({ file });
      try { await handle.writeFile(JSON.stringify({ operationId: c.operationId })); await handle.sync(); }
      finally { await handle.close(); }
    }
    await fs.mkdir(backup, { mode: 0o700 }); journalCreated = true;
    await fs.mkdir(path.join(backup, "configuration"), { mode: 0o700 });
    await record("preparing");
    // Recheck all selected files after acquiring the same locks used by configuration/publication.
    for (const file of s.files) demand(await s.read(file.file) === file.body, "REMOVAL_CONFIGURATION_CHANGED");
    demand(await s.read(path.join(original, ".core-install-owner.json")) === s.ownerText && await s.read(path.join(original, "shared/runtime-context.json")) === s.contextText && await fs.realpath(path.join(original, "current")) === await fs.realpath(s.release), "REMOVAL_OWNER_MISMATCH");
    step = "stop"; await record("running");
    // Pause only our timer/service and our LMS. PostgreSQL and global Nginx never stop.
    for (const item of [...s.states].sort((a, b) => Number(b.name.endsWith(".timer")) - Number(a.name.endsWith(".timer")))) {
      stopped.push(item);
      await run("systemctl", ["stop", item.name]);
      const active = (await run("systemctl", ["is-active", item.name], { allowInactive: true })).trim();
      demand(["inactive", "failed"].includes(active), "REMOVAL_SERVICE_STILL_RUNNING");
    }
    step = "backup_database"; await record("running");
    const dump = path.join(backup, "database.dump"), password = decodeURIComponent(s.database.password);
    s.database.password = "";
    const env = { PATH: process.env.PATH, LANG: "C.UTF-8", PGCONNECT_TIMEOUT: "10", PGPASSWORD: password };
    try {
      await run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", dump, "--dbname", s.database.href], { env, timeout: 15 * 60 * 1000 });
    } finally { delete env.PGPASSWORD; }
    const dumpStat = await fs.lstat(dump);
    demand(dumpStat.isFile() && !dumpStat.isSymbolicLink() && dumpStat.nlink === 1 && dumpStat.size > 0, "REMOVAL_BACKUP_INVALID");
    await fs.chmod(dump, 0o600);
    const listing = await run("pg_restore", ["--list", dump]);
    demand(/TABLE DATA/.test(listing) && /clients/.test(listing), "REMOVAL_BACKUP_INVALID");
    journal.databaseDumpSha256 = await checksum(dump); journal.databaseDumpBytes = dumpStat.size;
    step = "archive_configuration"; await record("running");
    for (const file of s.files) {
      demand(await s.read(file.file) === file.body, "REMOVAL_CONFIGURATION_CHANGED");
      if (file.kind !== "nginx") await run("systemctl", ["disable", file.name]);
      const destination = path.join(backup, "configuration", file.name);
      await fs.rename(file.file, destination); moved.push({ ...file, destination });
    }
    await run("systemctl", ["daemon-reload"]);
    if (s.files.some(file => file.kind === "nginx")) { await run("nginx", ["-t"]); await run("systemctl", ["reload", "nginx"]); }
    step = "archive_application"; await record("running");
    await fs.rename(original, path.join(backup, "application")); archived = true;
    step = "complete"; await record("uninstalled");
    return { ...journal, databaseDeleted: false, serviceAccountDeleted: false, certificatesDeleted: false };
  } catch (error) {
    let restored = true;
    try {
      if (archived) { await fs.rename(path.join(backup, "application"), original); archived = false; }
      for (const file of moved.reverse()) {
        try { await fs.lstat(file.file); restored = false; }
        catch (missing) {
          if (missing.code !== "ENOENT") throw missing;
          demand(await s.read(file.destination) === file.body, "REMOVAL_ROLLBACK_CHANGED");
          await fs.rename(file.destination, file.file);
        }
      }
      demand(restored, "REMOVAL_ROLLBACK_CONFIGURATION_OCCUPIED");
      if (moved.length) await run("systemctl", ["daemon-reload"]);
      if (moved.some(file => file.kind === "nginx")) { await run("nginx", ["-t"]); await run("systemctl", ["reload", "nginx"]); }
      for (const item of stopped) {
        if (item.enabled) await run("systemctl", ["enable", item.name]);
        if (item.active) { await run("systemctl", ["start", item.name]); demand((await run("systemctl", ["is-active", item.name])).trim() === "active", "REMOVAL_ROLLBACK_FAILED"); }
      }
    } catch { restored = false; }
    if (!journalCreated) throw Object.assign(Error("REMOVAL_NOT_STARTED"), { code: error.code === "EEXIST" ? "REMOVAL_BUSY_OR_BACKUP_EXISTS" : "REMOVAL_NOT_STARTED" });
    journal.errorCode = /^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "REMOVAL_FAILED";
    journal.rollbackRestored = restored;
    await record(restored ? "failed" : "needs_attention");
    return journal;
  } finally {
    s.database.password = "";
    for (const lock of locks.reverse()) {
      const file = archived && lock.file.startsWith(original + path.sep) ? path.join(backup, "application", path.relative(original, lock.file)) : lock.file;
      try { const owner = JSON.parse(await fs.readFile(file, "utf8")); if (owner.operationId === c.operationId) await fs.unlink(file); } catch { /* Preserve an unknown lock instead of deleting another operation's file. */ }
    }
  }
}
module.exports = { validateRemoval, expectedService, inspectRemoval, uninstallLms };
