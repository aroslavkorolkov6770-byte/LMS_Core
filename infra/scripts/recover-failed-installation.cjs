"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const demand = (ok, code) => { if (!ok) throw Object.assign(Error(code), { code }); };
async function command(file, args) {
  try { return (await promisify(execFile)(file, args, { timeout: 20000, maxBuffer: 256 * 1024, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } })).stdout; }
  catch (error) { throw Object.assign(Error("RECOVERY_COMMAND_FAILED"), { code: "RECOVERY_COMMAND_FAILED", exitCode: error.code }); }
}
function validate(input) {
  demand(input && ["clientId", "jobId", "releaseId"].every(key => UUID.test(input[key])) && /^\/srv\/lms-core\/clients\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.appPath), "RECOVERY_INPUT_INVALID");
  return { ...input, user: "lms-" + crypto.createHash("sha256").update(input.clientId).digest("hex").slice(0, 20), archive: `/srv/lms-core/recovery/${input.jobId}` };
}
async function inspectRecovery(input, options = {}) {
  const c = validate(input);
  demand(options.fixture || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const disk = value => options.root ? path.join(options.root, value) : value, run = options.run || command;
  const directory = async file => {
    if (options.root && file === path.resolve(options.root)) return;
    if (path.dirname(file) !== file) await directory(path.dirname(file));
    const s = await fs.lstat(file); demand(s.isDirectory() && !s.isSymbolicLink() && (options.fixture || s.uid === 0 && !(s.mode & 0o022)), "RECOVERY_PATH_UNSAFE");
  };
  const json = async file => {
    await directory(path.dirname(disk(file)));
    const s = await fs.lstat(disk(file)); demand(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 65536 && (options.fixture || s.uid === 0 && !(s.mode & 0o077)), "RECOVERY_FILE_UNSAFE");
    return JSON.parse(await fs.readFile(disk(file), "utf8"));
  };
  const absent = async file => { try { await fs.lstat(disk(file)); demand(false, "RECOVERY_RESOURCE_STILL_PRESENT"); } catch (e) { if (e.code !== "ENOENT") throw e; } };
  const statusFile = `/srv/lms-core/jobs/${c.jobId}/status.json`, status = await json(statusFile);
  demand(status.id === c.jobId && status.clientId === c.clientId && status.releaseId === c.releaseId && ["failed", "needs_attention"].includes(status.phase) && status.failedStep === "initialize", "RECOVERY_JOB_MISMATCH");
  const owner = await json(c.appPath + "/.core-install-owner.json");
  demand(owner.state === "installing" && owner.clientId === c.clientId && owner.jobId === c.jobId && owner.releaseId === c.releaseId, "RECOVERY_OWNER_MISMATCH");
  for (const file of [c.appPath + "/current", c.appPath + "/shared/runtime-vault.json", c.appPath + "/shared/runtime-context.json", `/etc/nginx/conf.d/lms-core-${c.clientId}.conf`, ...["api", "web"].map(role => `/etc/systemd/system/lms-${path.posix.basename(c.appPath)}-${role}.service`)]) await absent(file);
  try {
    const pidText = await fs.readFile(disk(`/srv/lms-core/jobs/${c.jobId}/worker.pid`), "utf8");
    demand(/^\d+\s*$/.test(pidText), "RECOVERY_PID_INVALID");
    try { const cmd = await fs.readFile(`/proc/${Number(pidText)}/cmdline`, "utf8"); demand(!cmd.includes(`/srv/lms-core/jobs/${c.jobId}/lms-install-job.cjs`), "RECOVERY_WORKER_RUNNING"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const suffix = c.clientId.replaceAll("-", ""), sql = `SELECT (SELECT count(*) FROM pg_database WHERE datname='lms_${suffix}')::text || '|' || (SELECT count(*) FROM pg_roles WHERE rolname='lms_role_${suffix}')::text`;
  const database = options.inspectDatabase ? await options.inspectDatabase() : (await run("runuser", ["-u", "postgres", "--", "psql", "-X", "-A", "-t", "-w", "-h", "/var/run/postgresql", "-d", "postgres", "-c", sql])).trim();
  demand(database === "0|0", "RECOVERY_DATABASE_EXISTS_REQUIRES_RESUME");
  const users = (await run("getent", ["passwd"])).trim().split("\n").map(line => line.split(":")), user = users.find(row => row[0] === c.user);
  demand(user && user[5] === c.appPath + "/shared/home" && user[6] === "/usr/sbin/nologin" && Number(user[2]) > 100 && Number(user[2]) < 65534 && users.filter(row => row[2] === user[2] || row[3] === user[3]).length === 1, "RECOVERY_SERVICE_ACCOUNT_MISMATCH");
  const rootStat = await fs.lstat(disk(c.appPath)); demand(options.fixture || rootStat.gid === Number(user[3]), "RECOVERY_ACCOUNT_OWNER_MISMATCH");
  const groups = (await run("id", ["-G", c.user])).trim().split(/\s+/); demand(groups.length === 1 && groups[0] === user[3], "RECOVERY_FOREIGN_GROUPS");
  const group = (await run("getent", ["group", c.user])).trim().split(":"); demand(group[0] === c.user && group[2] === user[3] && !group[3], "RECOVERY_FOREIGN_GROUP_MEMBERS");
  try { demand(!(await run("ps", ["-u", user[2], "-o", "pid="])).trim(), "RECOVERY_SERVICE_ACCOUNT_BUSY"); } catch (e) { if (e.exitCode !== 1) throw e; }
  return { c, disk, run, status, statusFile, directory, absent, databaseAbsent: true, roleAbsent: true, phase: "retry_available" };
}
async function recoverFailedInstallation(input, options = {}) {
  demand(options.agreement === true, "RECOVERY_CONFIRMATION_REQUIRED");
  const s = await inspectRecovery(input, options), { c, disk, run } = s;
  await s.absent(c.archive);
  await fs.mkdir(disk("/srv/lms-core/recovery"), { recursive: true, mode: 0o700 }); await s.directory(disk("/srv/lms-core/recovery"));
  demand((await fs.stat(disk(c.appPath))).dev === (await fs.stat(disk("/srv/lms-core/recovery"))).dev, "RECOVERY_FILESYSTEM_DIFFERS");
  await fs.mkdir(disk(c.archive), { mode: 0o700 });
  const receipt = { version: 1, clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, archivePath: c.archive, phase: "archiving", databaseAbsent: true, roleAbsent: true, updatedAt: new Date().toISOString() };
  const record = async () => fs.writeFile(disk(c.archive + "/receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
  await record();
  await fs.rename(disk(c.appPath), disk(c.archive + "/application"));
  // Retained files must not become accessible to a future Linux account reusing this UID.
  await run("chown", ["-hR", "root:root", disk(c.archive + "/application")]);
  await run("userdel", [c.user]);
  receipt.phase = "retry_available"; receipt.updatedAt = new Date().toISOString(); await record();
  const status = { ...s.status, phase: "failed", errorCode: "INSTALLATION_RETRY_READY", updatedAt: receipt.updatedAt };
  const file = disk(s.statusFile), temporary = file + ".recovery.tmp";
  await fs.writeFile(temporary, JSON.stringify(status), { flag: "wx", mode: 0o600 }); await fs.rename(temporary, file);
  return receipt;
}
module.exports = { validate, inspectRecovery, recoverFailedInstallation };
