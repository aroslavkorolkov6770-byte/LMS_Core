"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
async function inspectEmptyInstallation(input, options = {}) {
  const demand = (ok) => { if (!ok) throw Error("EMPTY_INSTALLATION_NOT_CONFIRMED"); };
  demand(input && ["clientId", "jobId", "releaseId"].every(key => UUID.test(input[key])) && /^\/srv\/lms-core\/clients\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.appPath));
  demand(options.fixture || process.platform === "linux" && process.getuid() === 0);
  const disk = file => options.root ? path.join(options.root, file) : file;
  const absent = async file => { try { await fs.lstat(disk(file)); demand(false); } catch (error) { if (error.code !== "ENOENT") throw error; } };
  const statusFile = disk(`/srv/lms-core/jobs/${input.jobId}/status.json`), stat = await fs.lstat(statusFile);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.size < 65536 && (options.fixture || stat.uid === 0 && !(stat.mode & 0o077)));
  const state = JSON.parse(await fs.readFile(statusFile, "utf8"));
  demand(state.id === input.jobId && state.clientId === input.clientId && state.releaseId === input.releaseId && state.phase === "needs_attention" && state.failedStep === "reserve" && state.errorCode === "NAMESPACE_NOT_TRAVERSABLE");
  await absent(input.appPath);
  for (const role of ["api", "web"]) await absent(`/etc/systemd/system/lms-${path.posix.basename(input.appPath)}-${role}.service`);
  await absent(`/etc/nginx/conf.d/lms-core-${input.clientId}.conf`);
  try {
    const pid = Number((await fs.readFile(disk(`/srv/lms-core/jobs/${input.jobId}/worker.pid`), "utf8")).trim());
    demand(Number.isSafeInteger(pid) && pid > 1);
    try { const cmd = await fs.readFile(`/proc/${pid}/cmdline`, "utf8"); demand(!cmd.includes(`/srv/lms-core/jobs/${input.jobId}/lms-install-job.cjs`)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const run = options.run || (async (file, args) => (await promisify(execFile)(file, args, { timeout: 15000, maxBuffer: 128 * 1024 })).stdout);
  const user = "lms-" + crypto.createHash("sha256").update(input.clientId).digest("hex").slice(0, 20);
  demand(!(await run("getent", ["passwd"])).split("\n").some(row => row.split(":")[0] === user));
  const suffix = input.clientId.replaceAll("-", ""), sql = `SELECT (SELECT count(*) FROM pg_database WHERE datname='lms_${suffix}')::text || '|' || (SELECT count(*) FROM pg_roles WHERE rolname='lms_role_${suffix}')::text`;
  const result = await run("runuser", ["-u", "postgres", "--", "psql", "-XAtw", "-h", "/var/run/postgresql", "-p", "5432", "-d", "postgres", "-c", sql]);
  demand(result.trim() === "0|0");
  return { empty: true, clientId: input.clientId, jobId: input.jobId, releaseId: input.releaseId };
}
module.exports = { inspectEmptyInstallation };
