"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { validateJob, readSecretInput, verifyPackage, createInstallDriver, executeNewInstall } = require("./lms-new-install-worker.cjs");
const run = promisify(execFile);
const fail = (code) => { throw Object.assign(Error(code), { code }); };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function loadJob(file) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) fail("LINUX_ROOT_REQUIRED");
  const config = JSON.parse(await fsp.readFile(file, "utf8"));
  validateJob(config.job);
  if (Object.keys(config).sort().join(",") !== "job,sha256" || !/^[a-f0-9]{64}$/.test(config.sha256) || file !== `/srv/lms-core/jobs/${config.job.id}/job.json`) fail("INVALID_INSTALL_JOB");
  let current = "";
  for (const part of path.dirname(file).split("/").filter(Boolean)) {
    current += "/" + part;
    const stat = await fsp.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail("UNSAFE_JOB_DIRECTORY");
  }
  for (const name of ["job.json", "lms-install-job.cjs", "lms-new-install-worker.cjs", "runtime-process.cjs", "source-curriculum.cjs", "code.tar"]) {
    const stat = await fsp.lstat(path.join(path.dirname(file), name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077)) fail("UNSAFE_JOB_FILE");
  }
  return config;
}

function statusWriter(directory, job) {
  const events = [];
  return (value) => {
    events.push({ phase: value.phase, at: new Date().toISOString() });
    if (events.length > 64) events.shift();
    const temporary = path.join(directory, `status.${job.id}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({ id: job.id, releaseId: job.releaseId, clientId: job.client.id,
      updatedAt: new Date().toISOString(), events, ...value }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, "status.json"));
  };
}

function validateArchiveListing(names, details) {
  for (const entry of names.split("\n").filter(Boolean)) {
    const name = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (!name || name === ".") continue;
    if (name.includes("\\") || name.split("/").some((part) => !part || part === ".." || part === ".") ||
      !(name === "release-manifest.json" || /^(?:lms|backend|installer)(?:\/|$)/.test(name))) fail("UNSAFE_ARCHIVE_PATH");
  }
  if (details.split("\n").filter(Boolean).some((line) => !["-", "d"].includes(line[0]))) fail("UNSAFE_ARCHIVE_ENTRY");
}

async function executeJob(file, config, secrets) {
  const directory = path.dirname(file), job = config.job;
  await fsp.writeFile(path.join(directory, ".run.lock"), job.id, { flag: "wx", mode: 0o600 });
  const persist = statusWriter(directory, job);
  let installationStarted = false;
  try {
    persist({ phase: "verifying" });
    const archive = path.join(directory, "code.tar");
    if (sha(await fsp.readFile(archive)) !== config.sha256) fail("ARCHIVE_HASH_MISMATCH");
    const names = await run("tar", ["-tf", archive], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const details = await run("tar", ["-tvf", archive], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    validateArchiveListing(names.stdout, details.stdout);
    const payload = path.join(directory, "payload");
    await fsp.mkdir(payload, { mode: 0o700 });
    persist({ phase: "extracting" });
    await run("tar", ["-xf", archive, "--no-same-owner", "--no-same-permissions", "-C", payload], { timeout: 60000 });
    await verifyPackage(payload, job.releaseId);
    for (const name of ["lms-new-install-worker.cjs", "runtime-process.cjs", "lms-install-job.cjs", "source-curriculum.cjs"]) {
      if (sha(await fsp.readFile(path.join(directory, name))) !== sha(await fsp.readFile(path.join(payload, "installer", name)))) fail("WORKER_VERSION_MISMATCH");
    }
    installationStarted = true;
    const result = await executeNewInstall(createInstallDriver(job, secrets, payload), (phase) => persist({ phase }));
    persist({ ...result, webPort: job.webPort, apiPort: job.apiPort });
    return result;
  } catch (error) {
    const allowed = ["ARCHIVE_HASH_MISMATCH", "UNSAFE_ARCHIVE_PATH", "UNSAFE_ARCHIVE_ENTRY", "WORKER_VERSION_MISMATCH"];
    const result = { phase: installationStarted ? "needs_attention" : "failed", errorCode: allowed.includes(error.code) ? error.code : "INSTALL_JOB_PREPARATION_FAILED" };
    persist(result); return result;
  }
}

async function main() {
  if (process.argv.length !== 4 || !["--launch", "--run"].includes(process.argv[2])) fail("INVALID_INSTALL_ARGUMENTS");
  const file = path.resolve(process.argv[3]), config = await loadJob(file);
  const secrets = await readSecretInput(process.stdin);
  if (process.argv[2] === "--run") {
    const result = await executeJob(file, config, secrets); if (result.phase !== "succeeded") process.exitCode = 1; return;
  }
  const directory = path.dirname(file);
  await fsp.writeFile(path.join(directory, ".launch.lock"), config.job.id, { flag: "wx", mode: 0o600 });
  const log = fs.openSync(path.join(directory, "job.private.log"), "wx", 0o600);
  try {
    const child = spawn(process.execPath, [__filename, "--run", file], { detached: true, stdio: ["pipe", log, log], env: { PATH: process.env.PATH, HOME: "/root", LANG: "C.UTF-8" } });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(Error("INSTALL_PROCESS_START_FAILED"))); });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(secrets), () => child.stdin.destroy());
    await fsp.writeFile(path.join(directory, "worker.pid"), String(child.pid), { flag: "wx", mode: 0o600 });
    child.unref(); process.stdout.write(JSON.stringify({ launched: true, id: config.job.id }));
  } finally { fs.closeSync(log); }
}
module.exports = { validateArchiveListing, statusWriter, executeJob, loadJob };
if (require.main === module) void main().catch(() => { process.stderr.write('{"errorCode":"INSTALL_JOB_START_UNCONFIRMED"}\n'); process.exitCode = 1; });
