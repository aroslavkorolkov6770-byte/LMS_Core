"use strict";
const fs = require("node:fs/promises");
const sync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { environment } = require("./configure-lms-ai.cjs");
const { verifyPackage } = require("./lms-new-install-worker.cjs");
const { executeUpdate, UpdateError } = require("./lms-update-worker.cjs");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const demand = (condition, code) => { if (!condition) throw new UpdateError(code); };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const profile = { keys: [], capability: { file: "app/api/core-runtime/health/route.ts", required: ["lms-core-client-v1", "postgresql-runtime"] } };
const exists = async file => { try { return await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };

function validateConfig(c) {
  demand(c && ["id", "clientId", "jobId", "releaseId", "packageId"].every(key => UUID.test(c[key])) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(c.revision) && /^[a-f0-9]{64}$/.test(c.sha256), "MANAGED_UPDATE_CONFIG_INVALID");
  return c;
}

// Git builds run as the existing tenant user, without SSH/AI/SQL secrets in their environment.
async function build(e, cwd, options) {
  const env = { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: path.join(e.shared, "home"), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=1536", CORE_RUNTIME_CLIENT_ID: e.c.clientId };
  const log = await fs.open(path.join(e.shared, `update-${e.c.operationId}.private.log`), "wx", 0o600);
  const run = (args, timeout, code) => new Promise((resolve, reject) => {
    const child = spawn("runuser", ["--user", e.user, "--", ...args], { cwd, env, detached: true, stdio: ["ignore", log.fd, log.fd] });
    let force, timedOut = false;
    const stop = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); force = setTimeout(() => stop("SIGKILL"), 10000); }, timeout);
    child.once("error", () => { clearTimeout(timer); clearTimeout(force); stop("SIGKILL"); reject(new UpdateError(code)); });
    child.once("exit", exit => { clearTimeout(timer); clearTimeout(force); if (timedOut) stop("SIGKILL"); exit === 0 && !timedOut ? resolve() : reject(new UpdateError(timedOut ? "MANAGED_BUILD_TIMEOUT" : code)); });
  });
  try {
    if (options.build) await options.build(cwd);
    else {
      await run(["npm", "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], 20 * 60 * 1000, "DEPENDENCY_INSTALL_FAILED");
      await run([process.execPath, path.join(cwd, "node_modules/next/dist/bin/next"), "build", "--webpack"], 45 * 60 * 1000, "LMS_BUILD_FAILED");
    }
  } finally { await log.close(); }
}

async function runManagedUpdate(config, payload, options = {}, report = () => {}) {
  const c = validateConfig(config);
  const target = { clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, appPath: c.appPath, webPort: c.webPort, operationId: c.id };
  let e = await environment(target, { ...options, profile });
  const parent = path.dirname(e.app), stage = path.join(parent, `.web-update-${c.id}`), backup = path.join(parent, `.web-backup-${c.id}`);
  const lockPath = path.join(e.shared, "ai-configuration.lock");
  let lock, oldMoved = false, newMoved = false, receiptBefore, oldBuild, result;
  const protectedNames = [".env.production.local", ".env.local", ".env.production", ".env", "data", "uploads", "storage", "public/uploads"];
  const protectedState = new Map();
  const receiptPath = path.join(e.shared, "web-update-receipt.json");
  const driver = {
    async validate() {
      await e.health();
      const manifest = await (options.verifyPackage || verifyPackage)(payload, c.packageId);
      demand(manifest.revision === c.revision, "UPDATE_SOURCE_MISMATCH");
      const context = JSON.parse(await e.regular(path.join(e.shared, "runtime-context.json")));
      demand(!context.designSha256 && !await exists(path.join(e.app, "core-client-design.json")), "UPDATE_DESIGN_REBASE_REQUIRED");
      demand(digest(await fs.readFile(path.join(parent, "backend/baseline.sql"))) === digest(await fs.readFile(path.join(payload, "backend/baseline.sql"))), "UPDATE_BACKEND_MIGRATION_REQUIRED");
      demand(!await exists(stage) && !await exists(backup), "UPDATE_PATH_OCCUPIED");
      oldBuild = await e.regular(path.join(e.app, ".next/BUILD_ID"), true);
      receiptBefore = await e.optional(receiptPath);
      if (!options.fixture) {
        const disk = await fs.statfs(parent); demand(Number(disk.bavail) * Number(disk.bsize) >= 3 * 1024 ** 3, "UPDATE_DISK_LOW");
        const mem = await fs.readFile("/proc/meminfo", "utf8"), kib = key => Number(mem.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] || 0);
        demand(kib("MemTotal") + kib("SwapTotal") >= 3 * 1024 ** 2, "UPDATE_MEMORY_LOW");
      }
    },
    async build() {
      await fs.cp(path.join(payload, "lms"), stage, { recursive: true, errorOnExist: true, force: false });
      if (!options.fixture) await e.run("chown", ["-hR", `${e.user}:${e.user}`, stage]);
      await build(e, stage, options);
      const id = await fs.readFile(path.join(stage, ".next/BUILD_ID"), "utf8"); demand(id.trim().length > 0, "LMS_BUILD_MISSING");
    },
    async stop() {
      // Revalidate identity after the long build; do not stop a replaced or foreign installation.
      e = await environment(target, { ...options, profile }); await e.health();
      demand(await e.regular(path.join(e.app, ".next/BUILD_ID"), true) === oldBuild, "UPDATE_CURRENT_BUILD_CHANGED");
      await e.run("systemctl", ["stop", e.unit]);
    },
    async backup() {
      for (const name of protectedNames) {
        const from = path.join(e.app, name), to = path.join(stage, name), stat = await exists(from);
        demand(!await exists(to), "UPDATE_PROTECTED_PATH_OCCUPIED");
        if (!stat) continue;
        await fs.mkdir(path.dirname(to), { recursive: true });
        if (stat.isSymbolicLink()) {
          const destination = await fs.realpath(from);
          demand(destination === e.managed || destination.startsWith(e.shared + path.sep), "UPDATE_PROTECTED_LINK_UNSAFE");
          await fs.symlink(destination, to); protectedState.set(name, { link: destination });
        } else {
          demand(stat.isFile() || stat.isDirectory(), "UPDATE_PROTECTED_FILE_UNSAFE");
          await fs.cp(from, to, { recursive: true, verbatimSymlinks: true, filter: async file => { demand(!(await fs.lstat(file)).isSymbolicLink(), "UPDATE_DATA_LINK_UNSAFE"); return true; } });
          if (stat.isFile()) { await fs.chmod(to, 0o640); if (!options.fixture) await fs.chown(to, 0, e.account.gid); protectedState.set(name, { hash: digest(await fs.readFile(from)) }); }
          else if (!options.fixture) await e.run("chown", ["-hR", `${e.user}:${e.user}`, to]);
        }
      }
    },
    async switch() {
      await fs.rename(e.app, backup); oldMoved = true;
      demand(await fs.readFile(path.join(backup, ".next/BUILD_ID"), "utf8") === oldBuild, "UPDATE_BACKUP_UNCONFIRMED");
      await fs.rename(stage, e.app); newMoved = true;
    },
    async start() { await e.run("systemctl", ["start", e.unit]); },
    async health() {
      const attempts = options.attempts || 40;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          await e.health();
          if (!options.fixture) {
            const origin = `http://127.0.0.1:${c.webPort}`, page = await fetch(origin, { redirect: "error", signal: AbortSignal.timeout(5000) });
            const html = await page.text(); demand(page.ok && html.length < 2 * 1024 * 1024, "UPDATE_PAGE_FAILED");
            const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"<>]+\.(?:js|css)(?:\?[^"<>]*)?)"/g)].map(match => match[1]))];
            demand(assets.some(asset => /\.js(?:\?|$)/.test(asset)), "UPDATE_ASSETS_MISSING");
            for (const asset of assets.slice(0, 4)) { demand(!asset.includes(".."), "UPDATE_ASSET_INVALID"); const response = await fetch(origin + asset, { redirect: "error", signal: AbortSignal.timeout(5000) }); demand(response.ok && !/text\/html/i.test(response.headers.get("content-type") || ""), "UPDATE_ASSET_FAILED"); await response.body?.cancel(); }
          }
          return;
        } catch (error) { if (attempt + 1 === attempts) throw new UpdateError("UPDATE_HEALTH_FAILED"); await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1000)); }
      }
    },
    async commit() {
      for (const [name, original] of protectedState) {
        const file = path.join(e.app, name);
        demand(original.link ? await fs.realpath(file) === original.link : digest(await fs.readFile(file)) === original.hash, "UPDATE_PROTECTED_DATA_CHANGED");
      }
      await e.atomic(receiptPath, JSON.stringify({ version: 1, clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, operationId: c.id, revision: c.revision, packageId: c.packageId, backupPath: backup, updatedAt: new Date().toISOString() }));
    },
    async rollback() {
      const owner = JSON.parse(await e.regular(path.join(e.root, ".core-install-owner.json")));
      demand(owner.state === "installed" && owner.clientId === c.clientId && owner.jobId === c.jobId && owner.releaseId === c.releaseId && await fs.realpath(path.join(e.root, "current")) === parent, "UPDATE_ROLLBACK_OWNER_CHANGED");
      await e.run("systemctl", ["stop", e.unit]);
      if (newMoved) { await fs.rename(e.app, stage); newMoved = false; }
      if (oldMoved) { await fs.rename(backup, e.app); oldMoved = false; }
      if (receiptBefore !== null) await e.atomic(receiptPath, receiptBefore); else await fs.unlink(receiptPath).catch(error => { if (error.code !== "ENOENT") throw error; });
      await e.run("systemctl", ["start", e.unit]); await driver.health();
    }
  };
  try {
    try { lock = await fs.open(lockPath, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") throw new UpdateError("MANAGED_CONFIGURATION_BUSY"); throw error; }
    await lock.writeFile(JSON.stringify({ operationId: c.id, pid: process.pid, kind: "web-update" }));
    result = await executeUpdate(driver, report);
    return { ...result, ...(oldMoved ? { backupPath: backup } : {}) };
  } finally {
    try {
      if (result && ["failed", "rolled_back"].includes(result.phase) && !oldMoved && !newMoved && await exists(stage)) {
        demand(path.dirname(stage) === parent && path.basename(stage) === `.web-update-${c.id}` && !(await fs.lstat(stage)).isSymbolicLink(), "UPDATE_CLEANUP_UNSAFE");
        await fs.rm(stage, { recursive: true, force: true });
      }
    } finally { if (lock) { await lock.close(); await fs.unlink(lockPath); } }
  }
}

async function main() {
  const file = process.argv[2], c = validateConfig(JSON.parse(await fs.readFile(file, "utf8"))), job = path.dirname(file);
  demand(process.platform === "linux" && process.getuid() === 0 && job === `/var/lib/lms-core/jobs/${c.id}`, "MANAGED_UPDATE_JOB_UNSAFE");
  let latest = {};
  const persist = value => { latest = { ...latest, ...value }; const tmp = path.join(job, "status.tmp"); sync.writeFileSync(tmp, JSON.stringify({ id: c.id, clientId: c.clientId, ...latest, updatedAt: new Date().toISOString() }), { mode: 0o600 }); sync.renameSync(tmp, path.join(job, "status.json")); };
  // Long dependency/build stages still publish liveness without exposing private build logs.
  const heartbeat = setInterval(() => { if (latest.phase && !["succeeded", "failed", "rolled_back", "needs_attention"].includes(latest.phase)) try { persist(latest); } catch {} }, 15000);
  try {
    demand(digest(await fs.readFile(path.join(job, "code.tar"))) === c.sha256, "UPDATE_ARCHIVE_CHANGED");
    const exec = require("node:util").promisify(require("node:child_process").execFile);
    const archive = path.join(job, "code.tar");
    const names = await exec("tar", ["-tf", archive], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const details = await exec("tar", ["-tvf", archive], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    require("./lms-install-job.cjs").validateArchiveListing(names.stdout, details.stdout);
    const payload = path.join(job, "payload"); await fs.mkdir(payload, { mode: 0o700 });
    await exec("tar", ["-xf", archive, "-C", payload, "--no-same-owner", "--no-same-permissions"], { timeout: 120000 });
    persist(await runManagedUpdate(c, payload, {}, phase => persist({ phase })));
  } catch (error) { persist({ phase: "failed", errorCode: /^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "MANAGED_UPDATE_FAILED" }); }
  finally { clearInterval(heartbeat); }
}
module.exports = { runManagedUpdate, validateConfig };
if (require.main === module) main().catch(() => { process.exitCode = 1; });
