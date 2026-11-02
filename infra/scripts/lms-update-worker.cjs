"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const GiB = 1024 ** 3;
class UpdateError extends Error { constructor(code) { super(code); this.code = code; } }
const demand = (value, code) => { if (!value) throw new UpdateError(code); };
const safePath = (value) => typeof value === "string" && /^\/(?:[a-z0-9_-][a-z0-9_.-]*\/)+[a-z0-9_-][a-z0-9_.-]*$/i.test(value) && !value.includes("..");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hashFile = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  stream.on("error", reject);
  stream.on("data", (data) => hash.update(data));
  stream.on("end", () => resolve(hash.digest("hex")));
});

// The same lifecycle is used by the real worker and isolated failure/rollback tests.
async function executeUpdate(driver, report) {
  const announce = (phase) => { try { report(phase); } catch { /* Status storage failure must never prevent rollback. */ } };
  let stopped = false;
  let switched = false;
  let phase = "validating";
  try {
    announce(phase);
    await driver.validate();
    phase = "building"; announce(phase);
    await driver.build();
    phase = "stopping"; announce(phase);
    // Set the flag before stop: a command can stop the process but lose its response.
    stopped = true;
    await driver.stop();
    phase = "backup"; announce(phase);
    await driver.backup();
    phase = "switching"; announce(phase);
    switched = true;
    await driver.switch();
    phase = "starting"; announce(phase);
    await driver.start();
    phase = "health"; announce(phase);
    await driver.health();
    await driver.commit();
    announce("succeeded");
    return { phase: "succeeded", failedStep: null, errorCode: null };
  } catch (error) {
    const failedStep = phase;
    const errorCode = error instanceof UpdateError ? error.code : "UPDATE_FAILED";
    if (stopped) {
      announce("rolling_back");
      try {
        await driver.rollback(switched);
        announce("rolled_back");
        return { phase: "rolled_back", failedStep, errorCode };
      } catch {
        announce("needs_attention");
        return { phase: "needs_attention", failedStep, errorCode: "ROLLBACK_FAILED" };
      }
    }
    announce("failed");
    return { phase: "failed", failedStep, errorCode };
  }
}

function validateConfig(config) {
  demand(config && UUID.test(config.id) && safePath(config.appPath) && safePath(config.basePath), "INVALID_CONFIG");
  demand(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(config.revision) && /^[a-f0-9]{64}$/.test(config.sha256), "INVALID_CONFIG");
  demand(typeof config.allowSwap === "boolean", "INVALID_CONFIG");
  return config;
}

function command(file, args, options = {}) {
  try { return execFileSync(file, args, { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options }); }
  catch { throw new UpdateError("COMMAND_FAILED"); }
}

function privateDirectory(directory) {
  // Walk components before creating anything. Existing symlinks are never followed.
  const parts = directory.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const info = fs.lstatSync(current);
    demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o022), "UNSAFE_DIRECTORY");
  }
  fs.chmodSync(directory, 0o700);
}

function snapshotTree(root) {
  const hashes = [];
  const pending = [root];
  let total = 0;
  while (pending.length) {
    const file = pending.pop();
    const info = fs.lstatSync(file);
    demand(!info.isSymbolicLink(), "DATA_SYMLINK_UNSUPPORTED");
    if (info.isDirectory()) {
      hashes.push([path.relative(root, file), "directory"]);
      for (const name of fs.readdirSync(file)) pending.push(path.join(file, name));
    } else {
      demand(info.isFile() && info.size < 256 * 1024 * 1024, "DATA_FILE_UNSUPPORTED");
      total += info.size;
      demand(total <= 2 * GiB && hashes.length < 30000, "DATA_TOO_LARGE");
      hashes.push([path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
    }
  }
  return crypto.createHash("sha256").update(JSON.stringify(hashes.sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}

function processIds(pid) {
  const pending = [pid];
  const ids = new Set();
  while (pending.length && ids.size < 200) {
    const next = pending.pop();
    if (!Number.isSafeInteger(next) || next <= 1 || ids.has(next)) continue;
    ids.add(next);
    try { pending.push(...fs.readFileSync(`/proc/${next}/task/${next}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)); } catch {}
  }
  return ids;
}

function ownedPorts(pid) {
  const ids = processIds(pid);
  const ports = new Set();
  for (const row of command("ss", ["-ltnpH"]).split("\n")) {
    const pids = [...row.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    if (!pids.some((value) => ids.has(value))) continue;
    const address = row.trim().split(/\s+/)[3] || "";
    const port = Number(/:(\d+)$/.exec(address)?.[1]);
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

function requestPage(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: 6000, headers: { "Cache-Control": "no-cache" } }, (res) => {
      let bytes = 0;
      let html = "";
      res.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 2 * 1024 * 1024) html += chunk.toString("utf8"); else res.destroy(); });
      res.on("error", () => resolve(false));
      res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 400 && /<html[\s>]/i.test(html) && /_next\//.test(html)));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

function makeDriver(config, jobDir, reportExtra) {
  const appRoot = fs.realpathSync(config.appPath);
  demand(appRoot === config.appPath, "APP_ROOT_SYMLINK_UNSUPPORTED");
  const identity = crypto.createHash("sha256").update(appRoot).digest("hex").slice(0, 16);
  const managed = path.join(config.basePath, `app-${identity}`);
  const release = path.join(managed, "releases", config.id);
  const previous = path.join(managed, "previous", config.id);
  const failed = path.join(managed, "failed", config.id);
  const archive = path.join(jobDir, "code.tar");
  const backupDir = path.join("/var/backups/lms-core", identity, config.id);
  let pm;
  let port;
  let protectedNames = [];
  let oldMoved = false;
  let newMoved = false;
  let backupVerified = false;
  let buildLog;

  const rows = () => JSON.parse(command("pm2", ["jlist"]));
  const matching = () => rows().filter((row) => row.pm2_env?.pm_cwd === appRoot);
  const current = () => {
    const result = matching();
    demand(result.length === 1 && result[0].pm_id === pm.pm_id && result[0].name === pm.name, "PROCESS_CHANGED");
    return result[0];
  };
  const assertBackend = (row) => {
    let mode = row.pm2_env?.DATA_BACKEND ?? row.pm2_env?.env?.DATA_BACKEND;
    for (const name of [".env.production.local", ".env.local", ".env.production", ".env"]) {
      if (mode !== undefined) break;
      const file = path.join(appRoot, name);
      if (fs.existsSync(file)) {
        demand(fs.statSync(file).size < 512 * 1024, "ENV_TOO_LARGE");
        const match = /^(?:export\s+)?DATA_BACKEND\s*=\s*([^\r\n]*)/m.exec(fs.readFileSync(file, "utf8"));
        if (match) mode = match[1].replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
      }
    }
    if (mode === undefined) {
      const file = path.join(appRoot, "app/lib/database/config.ts");
      if (fs.existsSync(file) && /process\.env\.DATA_BACKEND\s*\|\|\s*['"]json['"]/.test(fs.readFileSync(file, "utf8"))) mode = "json";
    }
    demand(mode === "json", "ONLY_JSON_UPDATE_SUPPORTED");
  };
  const runBuild = (file, args, timeout) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: release, detached: true, stdio: ["ignore", buildLog, buildLog], env: {
      ...process.env, DATA_BACKEND: "json", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=2048"
    } });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000).unref();
      reject(new UpdateError("BUILD_TIMEOUT"));
    }, timeout);
    child.on("error", () => { clearTimeout(timer); reject(new UpdateError("BUILD_START_FAILED")); });
    child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new UpdateError("BUILD_FAILED")); });
  });
  const ensureMemory = () => {
    const mem = fs.readFileSync("/proc/meminfo", "utf8");
    const swapKiB = Number(/^SwapTotal:\s+(\d+)/m.exec(mem)?.[1] || 0);
    if (os.totalmem() + swapKiB * 1024 >= 4 * GiB) return;
    demand(config.allowSwap && process.getuid() === 0, "SWAP_PERMISSION_REQUIRED");
    const file = "/var/lib/lms-core/build.swap";
    const marker = `${file}.json`;
    if (fs.existsSync(file)) {
      const info = fs.lstatSync(file);
      demand(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o077) && info.size === 4 * GiB &&
        fs.existsSync(marker) && readJson(marker).initialized === true, "SWAP_FILE_ALREADY_EXISTS");
      command("swapon", [file]);
      reportExtra({ swapCreatedBytes: 4 * GiB });
      return;
    }
    demand(fs.statfsSync("/var/lib/lms-core").bavail * fs.statfsSync("/var/lib/lms-core").bsize > 7 * GiB, "DISK_LOW_FOR_SWAP");
    const fd = fs.openSync(file, "wx", 0o600);
    fs.closeSync(fd);
    command("fallocate", ["-l", String(4 * GiB), file], { timeout: 60000 });
    command("mkswap", [file]);
    fs.writeFileSync(marker, JSON.stringify({ initialized: true, bytes: 4 * GiB }), { mode: 0o600, flag: "wx" });
    command("swapon", [file]);
    reportExtra({ swapCreatedBytes: 4 * GiB });
    // Keep active swap until reboot; swapoff on a 1 GB server could trigger OOM.
  };

  return {
    async validate() {
      demand(process.platform === "linux" && process.getuid() === 0, "ROOT_LINUX_REQUIRED");
      const daemon = Number(fs.readFileSync(path.join(process.env.PM2_HOME || path.join(os.homedir(), ".pm2"), "pm2.pid"), "utf8"));
      demand(daemon > 1 && /PM2.*God Daemon/i.test(fs.readFileSync(`/proc/${daemon}/cmdline`, "utf8")), "PM2_DAEMON_NOT_RUNNING");
      const found = matching();
      demand(found.length === 1, "AMBIGUOUS_PROCESS");
      pm = found[0];
      demand(Number.isInteger(pm.pm_id) && pm.pm2_env.status === "online" && pm.pm2_env.exec_mode === "fork_mode", "UNSUPPORTED_PROCESS");
      assertBackend(pm);
      const script = pm.pm2_env.pm_exec_path || "";
      const args = Array.isArray(pm.pm2_env.args) ? pm.pm2_env.args.join(" ") : pm.pm2_env.args || "";
      demand(/(?:^|\/)npm(?:-cli\.js)?$/.test(script) || script === path.join(appRoot, "node_modules/next/dist/bin/next"), "UNSUPPORTED_START_COMMAND");
      demand(/^start(?:\s|$)/.test(args) && !/[;&|`$\r\n]/.test(args), "UNSUPPORTED_START_COMMAND");
      demand(!pm.pm2_env.watch, "WATCH_MODE_UNSUPPORTED");
      const ports = ownedPorts(pm.pid);
      demand(ports.length === 1, "AMBIGUOUS_HTTP_PORT");
      port = ports[0];
      demand(await requestPage(port), "OLD_SITE_HEALTH_FAILED");
      protectedNames = ["data", "uploads", "public/uploads", "storage", ".env.production.local", ".env.local", ".env.production", ".env"].filter((name) => fs.existsSync(path.join(appRoot, name)));
      demand(protectedNames.includes("data"), "DATA_MISSING");
      for (const name of protectedNames) {
        const file = path.join(appRoot, name);
        if (fs.lstatSync(file).isSymbolicLink()) {
          const real = fs.realpathSync(file);
          demand(real.startsWith(`${managed}/previous/`), "EXTERNAL_DATA_LINK");
        }
        snapshotTree(fs.realpathSync(file));
      }
      privateDirectory(managed);
      for (const name of ["releases", "previous", "failed"]) privateDirectory(path.join(managed, name));
      demand(fs.statSync(appRoot).dev === fs.statSync(managed).dev, "CROSS_DEVICE_SWITCH_UNSUPPORTED");
      const marker = path.join(managed, "owner.json");
      if (fs.existsSync(marker)) demand(readJson(marker).appRoot === appRoot, "INSTALLATION_IDENTITY_CHANGED");
      else fs.writeFileSync(marker, JSON.stringify({ appRoot }), { mode: 0o600, flag: "wx" });
      const space = fs.statfsSync(managed);
      demand(space.bavail * space.bsize > 7 * GiB, "DISK_LOW");
      demand(await hashFile(archive) === config.sha256, "CODE_HASH_MISMATCH");
      ensureMemory();
      reportExtra({ appPath: appRoot, port, processName: pm.name, managedPath: managed });
    },
    async build() {
      demand(!fs.existsSync(release), "RELEASE_ALREADY_EXISTS");
      fs.mkdirSync(release, { mode: 0o700 });
      const names = command("tar", ["-tf", archive]).split("\n").filter(Boolean);
      demand(names.length && names.every((name) => !name.startsWith("/") && !name.split("/").includes("..") &&
        !/^(?:data|uploads|storage)(?:\/|$)|^public\/uploads(?:\/|$)|(?:^|\/)\.env|(?:^|\/)(?:node_modules|\.git|\.next)(?:\/|$)/i.test(name)), "UNSAFE_CODE_ARCHIVE");
      command("tar", ["-xf", archive, "--no-same-owner", "-C", release], { timeout: 60000 });
      const pkg = readJson(path.join(release, "package.json"));
      demand((pkg.dependencies?.next || pkg.devDependencies?.next) && pkg.scripts?.build === "next build" && pkg.scripts?.start === "next start", "UNSUPPORTED_BUILD_SCRIPTS");
      demand(fs.existsSync(path.join(release, "package-lock.json")), "NPM_LOCK_REQUIRED");
      // Build against a disposable copy, never against live mutable client data.
      for (const name of protectedNames) {
        const destination = path.join(release, name);
        demand(!fs.existsSync(destination), "PROTECTED_PATH_IN_CODE");
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.cpSync(fs.realpathSync(path.join(appRoot, name)), destination, { recursive: true, dereference: false });
        if (name.startsWith(".env")) fs.chmodSync(destination, 0o600);
      }
      buildLog = fs.openSync(path.join(jobDir, "build.private.log"), "wx", 0o600);
      try {
        await runBuild("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], 15 * 60 * 1000);
        await runBuild("npm", ["run", "build", "--", "--webpack"], 45 * 60 * 1000);
      } finally { fs.closeSync(buildLog); }
      demand(fs.statSync(path.join(release, ".next/BUILD_ID")).size > 0, "BUILD_ID_MISSING");
      // Remove only the known disposable copies. Real data is not moved or deleted here.
      for (const name of protectedNames) {
        const destination = path.join(release, name);
        demand(destination.startsWith(`${release}/`) && fs.realpathSync(destination).startsWith(`${release}/`) && !fs.lstatSync(destination).isSymbolicLink(), "UNSAFE_STAGING_PATH");
        fs.rmSync(destination, { recursive: true });
        const source = fs.realpathSync(path.join(appRoot, name));
        const target = source.startsWith(`${appRoot}/`) ? path.join(previous, path.relative(appRoot, source)) : source;
        fs.symlinkSync(target, destination);
      }
      fs.writeFileSync(path.join(release, ".lms-core-release.json"), JSON.stringify({ id: config.id, revision: config.revision }), { flag: "wx", mode: 0o600 });
    },
    async stop() {
      const row = current();
      demand(row.pm2_env.status === "online" && ownedPorts(row.pid).includes(port), "PROCESS_CHANGED");
      assertBackend(row);
      command("pm2", ["stop", String(pm.pm_id)], { timeout: 30000 });
      demand(current().pm2_env.status === "stopped", "STOP_FAILED");
      const listeners = command("ss", ["-ltnpH"]).split("\n").some((row) => Number(/:(\d+)$/.exec(row.trim().split(/\s+/)[3] || "")?.[1]) === port);
      demand(!listeners, "PORT_STILL_IN_USE");
    },
    async backup() {
      privateDirectory(backupDir);
      const before = protectedNames.map((name) => [name, snapshotTree(fs.realpathSync(path.join(appRoot, name)))]);
      const file = path.join(backupDir, "installation.tar.gz");
      command("tar", ["-czhf", file, "--exclude=./node_modules", "--exclude=./.next", "--exclude=./.git", "-C", appRoot, "."], { timeout: 180000, maxBuffer: 1024 * 1024 });
      fs.chmodSync(file, 0o600);
      const check = path.join(backupDir, "verification");
      fs.mkdirSync(check, { mode: 0o700 });
      command("tar", ["-xzf", file, "--no-same-owner", "-C", check], { timeout: 180000 });
      for (const [name, hash] of before) {
        demand(snapshotTree(path.join(check, name)) === hash && snapshotTree(fs.realpathSync(path.join(appRoot, name))) === hash, "BACKUP_VERIFICATION_FAILED");
      }
      const sha256 = await hashFile(file);
      fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify({ appRoot, revision: config.revision, sha256, protectedHashes: before }), { mode: 0o600, flag: "wx" });
      backupVerified = true;
      reportExtra({ backupPath: file, backupSha256: sha256 });
    },
    async switch() {
      demand(backupVerified && current().pm2_env.status === "stopped" && !fs.existsSync(previous), "SWITCH_NOT_READY");
      fs.renameSync(appRoot, previous); oldMoved = true;
      fs.renameSync(release, appRoot); newMoved = true;
    },
    async start() { command("pm2", ["restart", String(pm.pm_id)], { timeout: 30000 }); },
    async health() {
      for (let attempt = 0; attempt < 30; attempt++) {
        const row = current();
        if (row.pm2_env.status === "online" && ownedPorts(row.pid).includes(port) && await requestPage(port)) {
          demand(readJson(path.join(appRoot, ".lms-core-release.json")).id === config.id, "RELEASE_ID_MISMATCH");
          for (const name of protectedNames) demand(fs.existsSync(path.join(appRoot, name)), "DATA_LINK_BROKEN");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new UpdateError("NEW_SITE_HEALTH_FAILED");
    },
    async commit() {
      fs.writeFileSync(path.join(managed, `success-${config.id}.json`), JSON.stringify({ id: config.id, appRoot, previous, revision: config.revision }), { mode: 0o600, flag: "wx" });
      reportExtra({ previousPath: previous });
    },
    async rollback() {
      current();
      if (newMoved) {
        command("pm2", ["stop", String(pm.pm_id)], { timeout: 30000 });
        fs.renameSync(appRoot, failed);
      }
      if (oldMoved) fs.renameSync(previous, appRoot);
      // No backup is restored over live writes: both releases use the original data.
      command("pm2", ["restart", String(pm.pm_id)], { timeout: 30000 });
      for (let attempt = 0; attempt < 30; attempt++) {
        const row = current();
        if (row.pm2_env.status === "online" && ownedPorts(row.pid).includes(port) && await requestPage(port)) return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new UpdateError("ROLLBACK_HEALTH_FAILED");
    }
  };
}

async function main() {
  process.umask(0o077);
  const configFile = process.argv[2];
  const jobDir = path.dirname(configFile || "");
  let status = { phase: "validating", updatedAt: new Date().toISOString() };
  let lock;
  const persist = (extra) => {
    status = { ...status, ...extra, updatedAt: new Date().toISOString() };
    const temporary = path.join(jobDir, "status.tmp");
    fs.writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 });
    fs.renameSync(temporary, path.join(jobDir, "status.json"));
  };
  try {
    const config = validateConfig(readJson(configFile));
    demand(jobDir === `/var/lib/lms-core/jobs/${config.id}`, "INVALID_JOB_DIRECTORY");
    demand(process.platform === "linux" && process.getuid() === 0, "ROOT_LINUX_REQUIRED");
    const locks = "/var/lib/lms-core/locks";
    privateDirectory(locks);
    const key = crypto.createHash("sha256").update(config.appPath).digest("hex");
    lock = path.join(locks, `${key}.lock`);
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ id: config.id, pid: process.pid }));
    fs.closeSync(fd);
    const result = await executeUpdate(makeDriver(config, jobDir, persist), (phase) => persist({ phase }));
    persist(result);
  } catch (error) {
    persist({ phase: "failed", errorCode: error?.code === "EEXIST" ? "INSTALLATION_LOCKED" : error instanceof UpdateError ? error.code : "WORKER_FAILED" });
  } finally {
    // A stale lock is never removed speculatively, only by its owning worker.
    if (lock) {
      try { if (readJson(lock).pid === process.pid) fs.unlinkSync(lock); } catch {}
    }
  }
}

module.exports = { executeUpdate, validateConfig, snapshotTree, UpdateError, ownedPorts, safePath };
if (require.main === module) main().catch(() => { process.exitCode = 1; });
