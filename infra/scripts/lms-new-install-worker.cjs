"use strict";
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { sealSecrets, openSecrets, roleEnvironment, systemEnvironment } = require("./runtime-process.cjs");
// Resolve required installer dependencies before build, database creation or administrator bootstrap.
const { initializeCurriculum, curriculumSummary } = require("./source-curriculum.cjs");
const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
class InstallError extends Error { constructor(code) { super(code); this.code = code; } }
const demand = (value, code) => { if (!value) throw new InstallError(code); };
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exists = async (file) => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

function validateJob(job) {
  demand(job && Object.keys(job).every((key) => ["version", "id", "releaseId", "client", "apiPort", "webPort", "contentMode", ...(job.version === 2 ? ["designSha256"] : [])].includes(key)), "INVALID_JOB");
  demand(job.contentMode === undefined || ["empty", "source"].includes(job.contentMode), "INVALID_CONTENT_MODE");
  demand([1, 2].includes(job.version) && (job.version === 1 || /^[a-f0-9]{64}$/.test(job.designSha256)) && UUID.test(job.id) && UUID.test(job.releaseId) && UUID.test(job.client?.id) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(job.client.slug) && job.client.slug.length <= 63, "INVALID_JOB");
  const clientFields = ["id", "name", "slug", "domain", "brandName", "tariff", "industryTemplate", "includedUsers", "maxAdmins", "aiRequestsLimit", "primaryColor"];
  demand(Object.keys(job.client).every((key) => clientFields.includes(key)), "INVALID_CLIENT_FIELDS");
  demand([job.apiPort, job.webPort].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) && job.apiPort !== job.webPort, "INVALID_PORTS");
  return job;
}
function validateSecrets(input) {
  const peer = input?.databaseMode === "local_peer", provision = input?.maintenanceUrl !== undefined;
  const names = [...(peer ? ["databaseMode", "databasePassword"] : provision ? ["maintenanceUrl", "databasePassword"] : ["databaseUrl"]), "clientAdminLogin", "clientAdminName", "clientAdminPassword", "systemAdminLogin", "systemAdminPassword"];
  demand(input && Object.keys(input).length === names.length && Object.keys(input).every((key) => names.includes(key)), "INVALID_SECRET_INPUT");
  demand(names.every((key) => typeof input[key] === "string" && input[key].length <= 4096), "INVALID_SECRET_INPUT");
  demand([input.clientAdminPassword, input.systemAdminPassword].every((value) => value.length >= 12 && value.length <= 128) && input.clientAdminLogin.toLowerCase() !== input.systemAdminLogin.toLowerCase(), "INVALID_ADMIN_INPUT");
  demand([input.clientAdminLogin, input.systemAdminLogin].every((value) => /^[a-z0-9][a-z0-9_.@+-]{0,119}$/i.test(value)) && input.clientAdminName.trim() && input.clientAdminName.length <= 150, "INVALID_ADMIN_INPUT");
  if (peer) { demand(/^[A-Za-z0-9_-]{43,128}$/.test(input.databasePassword), "INVALID_DATABASE_URL"); return input; }
  try { const url = new URL(provision ? input.maintenanceUrl : input.databaseUrl); demand(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && url.pathname.length > 1, "INVALID_DATABASE_URL");
    if (provision) demand(url.pathname === "/postgres" && /^[A-Za-z0-9_-]{43,128}$/.test(input.databasePassword) &&
      (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.searchParams.get("sslmode") === "verify-full"), "INVALID_DATABASE_URL"); }
  catch { throw new InstallError("INVALID_DATABASE_URL"); }
  return input;
}

async function verifyPackage(directory, releaseId) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "release-manifest.json"), "utf8"));
  demand(manifest.format === "lms-core-install-v1" && manifest.id === releaseId && manifest.protocol === "lms-core-runtime-v1" && ["empty", "source"].includes(manifest.contentMode) && manifest.targetBuildRequired === true && Array.isArray(manifest.files) && manifest.files.length <= 20000, "INVALID_RELEASE");
  const expected = new Set(["release-manifest.json"]);
  for (const entry of manifest.files) {
    demand(typeof entry.path === "string" && !entry.path.includes("\\") && !entry.path.split("/").some((part) => !part || part === "." || part === "..") && !expected.has(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256), "INVALID_RELEASE_PATH");
    demand(/^(?:backend|lms|installer)\//.test(entry.path), "INVALID_RELEASE_PATH");
    demand(!entry.path.split("/").some((part) => ["node_modules", ".next", ".git"].includes(part) || part.startsWith(".env")) && !/^lms\/(?:data|uploads|storage|public\/uploads)(?:\/|$)/.test(entry.path), "RUNTIME_DATA_IN_RELEASE");
    expected.add(entry.path);
  }
  const actual = [];
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      demand(!entry.isSymbolicLink(), "RELEASE_SYMLINK");
      if (entry.isDirectory()) await walk(file);
      else { demand(entry.isFile(), "RELEASE_FILE_TYPE"); actual.push(path.relative(directory, file).split(path.sep).join("/")); }
    }
  };
  await walk(directory);
  demand(actual.length === expected.size && actual.every((name) => expected.has(name)), "RELEASE_COMPOSITION_CHANGED");
  for (const name of ["lms/package-lock.json", "lms/app/api/core-runtime/health/route.ts", "lms/app/lib/storage/dataStore.ts", "backend/runtime-api.cjs", "backend/runtime-init.cjs", "backend/runtime-provision.cjs", "backend/baseline.sql", "backend/baseline-manifest.json", "installer/runtime-process.cjs", "installer/lms-new-install-worker.cjs", "installer/source-curriculum.cjs"]) demand(expected.has(name), "REQUIRED_RELEASE_FILE_MISSING");
  for (const entry of manifest.files) {
    demand((await fs.stat(path.join(directory, entry.path))).size <= 64 * 1024 * 1024, "RELEASE_FILE_TOO_LARGE");
    demand(hash(await fs.readFile(path.join(directory, entry.path))) === entry.sha256, "RELEASE_HASH_MISMATCH");
  }
  if (manifest.contentMode === "source") {
    demand(expected.has("installer/source-curriculum.json") && expected.has("installer/source-curriculum.cjs"), "CURRICULUM_PACKAGE_MISSING");
    const summary = curriculumSummary(JSON.parse(await fs.readFile(path.join(directory, "installer/source-curriculum.json"), "utf8")));
    demand(summary.revision === manifest.revision && JSON.stringify(summary) === JSON.stringify(manifest.curriculum), "CURRICULUM_PACKAGE_MISMATCH");
  } else demand(!manifest.curriculum && !expected.has("installer/source-curriculum.json"), "UNEXPECTED_CURRICULUM_PACKAGE");
  const pkg = JSON.parse(await fs.readFile(path.join(directory, "lms/package.json"), "utf8"));
  if (manifest.design) {
    const contract = require("./client-design-contract.cjs");
    demand(expected.has("lms/core-client-design.json") && expected.has("lms/core-client-design-contract.cjs") && expected.has("installer/client-design-contract.cjs"), "CLIENT_DESIGN_MISSING");
    const design = contract.validateClientDesign(JSON.parse(await fs.readFile(path.join(directory, "lms/core-client-design.json"), "utf8")));
    demand(manifest.design.version === design.version && UUID.test(manifest.design.id) && manifest.design.clientId === design.clientId && manifest.design.sha256 === contract.designHash(design), "CLIENT_DESIGN_MISMATCH");
    if (design.version === 3) demand(design.sourceRevision === manifest.revision && expected.has("lms/point-design-contract.cjs") && expected.has("installer/point-design-contract.cjs") && expected.has("lms/app/components/CorePointDesign.tsx") && !expected.has("lms/app/components/CoreClientDesign.tsx"), "POINT_DESIGN_MISMATCH");
    for (const asset of design.assets || []) {
      demand(expected.has(`lms/public/${asset.path}`), "CLIENT_DESIGN_ASSET_MISSING");
      const bytes = await fs.readFile(path.join(directory, "lms/public", asset.path));
      demand(bytes.length === asset.bytes && hash(bytes) === asset.sha256, "CLIENT_DESIGN_ASSET_CHANGED");
    }
  }
  demand(pkg.scripts?.build === "next build" && pkg.scripts?.start === "next start" && !["prebuild", "postbuild", "prestart", "poststart"].some((name) => pkg.scripts[name]), "UNSUPPORTED_LMS_CONTRACT");
  return manifest;
}

async function freePort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", () => reject(new InstallError("PORT_OCCUPIED"))).listen(port, "127.0.0.1", resolve));
  await new Promise((resolve) => server.close(resolve));
}
async function safeDirectory(directory, create) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    // Shared namespace parents must be traversable by the new unprivileged tenant user.
    if (!await exists(current) && create) { try { await fs.mkdir(current, { mode: 0o755 }); await fs.chmod(current, 0o755); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    const stat = await fs.lstat(current);
    demand(stat.isDirectory() && !stat.isSymbolicLink(), "UNSAFE_INSTALL_PATH");
    if (create && process.platform === "linux") demand((stat.mode & 0o001) !== 0, "NAMESPACE_NOT_TRAVERSABLE");
  }
}
async function command(file, args, options = {}) {
  if (options.input !== undefined) {
    const { input, ...settings } = options;
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { windowsHide: true, env: systemEnvironment(), ...settings, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", settled = false;
      const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(Object.assign(new Error("PRIVATE_COMMAND_FAILED"), { stdout, stderr })); else resolve({ stdout, stderr }); };
      const timer = setTimeout(() => { child.kill(); finish(true); }, settings.timeout || 45000);
      child.stdout.on("data", (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > 65536) { child.kill(); finish(true); } });
      child.stderr.on("data", (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > 65536) { child.kill(); finish(true); } });
      child.on("error", () => finish(true)); child.on("close", (code) => finish(code !== 0));
      child.stdin.on("error", () => finish(true)); child.stdin.end(input);
    });
  }
  return exec(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: systemEnvironment(), ...options });
}
async function poll(check, milliseconds = 45000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new InstallError("HEALTH_TIMEOUT");
}

async function stopPrivateGroup(ended, stop, stillRunning, timeout = 10000) {
  stop("SIGTERM");
  let timer;
  const finished = await Promise.race([ended.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout); })]);
  clearTimeout(timer);
  // Never signal a group again after its owner has exited: that ID may already have been reused.
  if (!finished && stillRunning()) { stop("SIGKILL"); await ended; }
}

// No stage stops an existing site. Failure cleanup is limited to this job's newly-created units.
async function executeNewInstall(driver, report = () => {}) {
  let phase = "validating", resourcesMayExist = false;
  const announce = (value) => { phase = value; try { report(value); } catch { throw new InstallError("STATUS_WRITE_FAILED"); } };
  try {
    for (const stage of ["validate", "reserve", "build", "initialize", "bootstrap", "configure", "activate", "health", "commit"]) {
      announce(stage);
      if (stage === "reserve") resourcesMayExist = true;
      await driver[stage]();
    }
    announce("succeeded");
    return { phase: "succeeded", failedStep: null, errorCode: null };
  } catch (error) {
    const failedStep = phase;
    let cleanupFailed = false;
    try { await driver.cleanup(); } catch { cleanupFailed = true; }
    const result = { phase: resourcesMayExist || cleanupFailed ? "needs_attention" : "failed", failedStep,
      errorCode: cleanupFailed ? "OWN_SERVICE_CLEANUP_FAILED" : error instanceof InstallError ? error.code : "NEW_INSTALL_FAILED" };
    try { announce(result.phase); } catch {}
    return result;
  }
}

function createInstallDriver(jobInput, secretInput, packageRoot, options = {}) {
  const job = validateJob(jobInput), input = options.resume === true ? null : validateSecrets(secretInput);
  const run = options.run || command;
  const base = options.base || "/srv/lms-core/clients";
  const units = options.unitDirectory || "/etc/systemd/system";
  const root = path.join(base, job.client.slug), releaseRoot = path.join(root, "releases", job.releaseId), shared = path.join(root, "shared");
  const user = `lms-${hash(Buffer.from(job.client.id)).slice(0, 20)}`;
  const unitNames = [`lms-${job.client.slug}-api.service`, `lms-${job.client.slug}-web.service`];
  const createdUnits = [];
  let committed = false, manifest, curriculum, privateFilesPrepared = false;
  let databaseUrl = input?.databaseUrl;
  if (input && (input.maintenanceUrl || input.databaseMode === "local_peer")) {
    const url = new URL(input.maintenanceUrl || "postgresql://postgres@127.0.0.1:5432/postgres"), suffix = job.client.id.replaceAll("-", "").toLowerCase();
    url.username = `lms_role_${suffix}`; url.password = input.databasePassword; url.pathname = `/lms_${suffix}`; databaseUrl = url.href;
  }
  const secrets = { databaseUrl, serviceToken: crypto.randomBytes(32).toString("base64url"), encryptionKey: crypto.randomBytes(32).toString("hex"), authSecret: crypto.randomBytes(48).toString("base64url") };
  const context = { clientId: job.client.id, releaseId: job.releaseId, releaseRoot, apiPort: job.apiPort, webPort: job.webPort, ...(job.version === 2 ? { designSha256: job.designSha256 } : {}) };
  const env = (role) => roleEnvironment(context, secrets, role);
  const asUser = (args, settings = {}) => run("runuser", ["--user", user, "--", process.execPath, ...args], settings);
  const fetcher = options.fetch || fetch;
  const marker = path.join(root, ".core-install-owner.json");
  const preparePrivateFiles = async () => {
    if (privateFilesPrepared) return;
    const key = crypto.randomBytes(32);
    for (const [name, body] of [["runtime-vault.key", key], ["runtime-vault.json", JSON.stringify(sealSecrets(secrets, key, job.client.id))], ["runtime-context.json", JSON.stringify(context)]]) {
      const file = path.join(shared, name);
      await fs.writeFile(file, body, { flag: "wx", mode: 0o640 }); await run("chgrp", [user, file]);
    }
    privateFilesPrepared = true;
  };
  const synchronizeContent = async write => {
    let result;
    try {
      result = await initializeCurriculum({ mode: manifest.contentMode, bundle: curriculum,
        apiPort: job.apiPort, serviceToken: secrets.serviceToken, write }, { fetch: fetcher });
    } catch (error) {
      const allowed = ["CURRICULUM_INSTALL_VERIFY_FAILED", "CURRICULUM_INSTALL_CONNECTION_FAILED", "CURRICULUM_REVISION_CONFLICT", "CURRICULUM_USERS_CHANGED", "CURRICULUM_USERS_UNAVAILABLE", "CURRICULUM_RUNTIME_FAILED", "CURRICULUM_WRITE_UNCONFIRMED", "CURRICULUM_PROTOCOL_INVALID", "CURRICULUM_READ_INVALID", "CURRICULUM_EXISTING_DATA_CONFLICT"];
      throw new InstallError(allowed.includes(error.code) ? error.code : "CURRICULUM_INSTALL_VERIFY_FAILED");
    }
    await fs.writeFile(path.join(shared, "content-receipt.json"), JSON.stringify({ clientId: job.client.id, releaseId: job.releaseId, ...result, checkedAt: new Date().toISOString() }), { mode: 0o600 });
  };
  const withPrivateApi = async (operation, bootstrapEnabled = false) => {
    await freePort(job.apiPort);
    const child = spawn("runuser", ["--user", user, "--", process.execPath, path.join(releaseRoot, "backend/runtime-api.cjs")], {
      env: { ...env("api"), LMS_RUNTIME_BOOTSTRAP_ENABLED: String(bootstrapEnabled) }, stdio: "ignore", detached: true
    });
    const ended = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
    try {
      await poll(async () => (await fetcher(`http://127.0.0.1:${job.apiPort}/api/lms-runtime/v1/health`, {
        headers: { Authorization: `Bearer ${secrets.serviceToken}`, Connection: "close" }, signal: AbortSignal.timeout(3000)
      })).ok);
      await operation();
    } finally {
      const stopGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } } };
      await stopPrivateGroup(ended, stopGroup, () => child.exitCode === null && child.signalCode === null);
    }
  };
  return {
    async validateResume() {
      demand(options.resume === true && (options.fixture === true || process.platform === "linux" && process.getuid?.() === 0), "RESUME_NOT_ALLOWED");
      manifest = await verifyPackage(packageRoot, job.releaseId);
      demand((job.contentMode ?? "empty") === manifest.contentMode, "JOB_CONTENT_MODE_MISMATCH");
      if (manifest.contentMode === "source") curriculum = JSON.parse(await fs.readFile(path.join(packageRoot, "installer/source-curriculum.json"), "utf8"));
      demand(manifest.design ? job.version === 2 && manifest.design.clientId === job.client.id && manifest.design.sha256 === job.designSha256 : job.version === 1, "JOB_DESIGN_MISMATCH");
      await safeDirectory(root, false); await safeDirectory(shared, false); await safeDirectory(releaseRoot, false);
      const regular = async name => {
        const file = path.join(shared, name), stat = await fs.lstat(file);
        demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
          (options.fixture === true || stat.uid === 0 && !(stat.mode & 0o027)), "RESUME_PRIVATE_FILE_UNSAFE");
        return fs.readFile(file);
      };
      const owner = JSON.parse(await fs.readFile(marker, "utf8"));
      demand(owner.jobId === job.id && owner.clientId === job.client.id && owner.releaseId === job.releaseId && owner.state === "installing", "RESUME_OWNER_MISMATCH");
      demand(JSON.stringify(JSON.parse(await regular("runtime-context.json"))) === JSON.stringify(context), "RESUME_CONTEXT_MISMATCH");
      const key = await regular("runtime-vault.key"); demand(key.length === 32, "RESUME_VAULT_INVALID");
      let saved;
      try { saved = openSecrets(JSON.parse(await regular("runtime-vault.json")), key, job.client.id); }
      catch { throw new InstallError("RESUME_VAULT_INVALID"); }
      demand(Object.keys(saved).sort().join(",") === "authSecret,databaseUrl,encryptionKey,serviceToken" &&
        /^[A-Za-z0-9_-]{43,256}$/.test(saved.serviceToken) && /^[a-f0-9]{64}$/.test(saved.encryptionKey) &&
        /^[A-Za-z0-9_-]{43,256}$/.test(saved.authSecret), "RESUME_VAULT_INVALID");
      try { const url = new URL(saved.databaseUrl); demand(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && url.pathname.length > 1, "RESUME_VAULT_INVALID"); }
      catch { throw new InstallError("RESUME_VAULT_INVALID"); }
      // Resume only the pre-activation boundary. Never replace an installed release or another service.
      demand(!await exists(path.join(root, "current")), "RESUME_ALREADY_CONFIGURED");
      for (const name of unitNames) demand(!await exists(path.join(units, name)), "SERVICE_UNIT_EXISTS");
      demand((await fs.stat(path.join(releaseRoot, "lms/.next/BUILD_ID"))).size > 0, "LMS_BUILD_MISSING");
      await run("id", ["-u", user]); await freePort(job.apiPort); await freePort(job.webPort);
      Object.assign(secrets, saved); privateFilesPrepared = true;
    },
    async resumeContent() {
      demand(options.resume === true && privateFilesPrepared, "RESUME_NOT_ALLOWED");
      // Existing administrators are read and checked, never bootstrapped a second time.
      if (options.bootstrap) await synchronizeContent(true);
      else await withPrivateApi(() => synchronizeContent(true));
    },
    async validate() {
      demand(options.fixture === true || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
      demand(Number(process.versions.node.split(".")[0]) >= 22, "NODE_22_REQUIRED");
      manifest = await verifyPackage(packageRoot, job.releaseId);
      demand((job.contentMode ?? "empty") === manifest.contentMode, "JOB_CONTENT_MODE_MISMATCH");
      if (manifest.contentMode === "source") curriculum = JSON.parse(await fs.readFile(path.join(packageRoot, "installer/source-curriculum.json"), "utf8"));
      demand(manifest.design ? job.version === 2 && manifest.design.clientId === job.client.id && manifest.design.sha256 === job.designSha256 : job.version === 1, "JOB_DESIGN_MISMATCH");
      demand(!await exists(root), "INSTALL_PATH_OCCUPIED");
      for (const name of unitNames) demand(!await exists(path.join(units, name)), "SERVICE_UNIT_EXISTS");
      await freePort(job.apiPort); await freePort(job.webPort);
      let found = false;
      try { await run("id", ["-u", user]); found = true; } catch (error) { demand(error.code === 1, "SERVICE_ACCOUNT_CHECK_FAILED"); }
      demand(!found, "SERVICE_ACCOUNT_EXISTS");
      for (const [file, args] of [["systemctl", ["--version"]], ["runuser", ["--version"]], ["npm", ["--version"]]]) await run(file, args);
    },
    async reserve() {
      await safeDirectory(base, true);
      await fs.mkdir(root, { mode: 0o750 });
      await fs.writeFile(marker, JSON.stringify({ jobId: job.id, clientId: job.client.id, releaseId: job.releaseId, state: "installing" }), { flag: "wx", mode: 0o600 });
      await run("useradd", ["--system", "--user-group", "--home-dir", path.join(shared, "home"), "--shell", "/usr/sbin/nologin", user]);
      await fs.mkdir(releaseRoot, { recursive: true, mode: 0o750 }); await fs.mkdir(shared, { mode: 0o750 });
      await fs.cp(path.join(packageRoot, "lms"), path.join(releaseRoot, "lms"), { recursive: true, errorOnExist: true });
      await fs.cp(path.join(packageRoot, "backend"), path.join(releaseRoot, "backend"), { recursive: true, errorOnExist: true });
      await fs.copyFile(path.join(packageRoot, "installer/runtime-process.cjs"), path.join(releaseRoot, "backend/runtime-process.cjs"));
      await fs.mkdir(path.join(shared, "home"), { mode: 0o750 });
      await run("chgrp", ["-R", user, root]);
      await run("chown", ["-R", `${user}:${user}`, path.join(releaseRoot, "lms")]);
      await run("chown", [`${user}:${user}`, path.join(shared, "home")]);
    },
    async build() {
      const cwd = path.join(releaseRoot, "lms");
      const buildEnv = { ...systemEnvironment(), HOME: path.join(shared, "home"), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", CORE_RUNTIME_CLIENT_ID: job.client.id, ...(job.version === 2 ? { CORE_RUNTIME_DESIGN_SHA256: job.designSha256 } : {}) };
      const log = path.join(shared, "build.private.log");
      await fs.writeFile(log, "", { flag: "wx", mode: 0o600 });
      const buildStep = async (code, operation) => {
        try {
          const result = await operation(); await fs.appendFile(log, `${result.stdout || ""}${result.stderr || ""}`.slice(-1024 * 1024));
        } catch (error) {
          await fs.appendFile(log, `${typeof error.stdout === "string" ? error.stdout : ""}${typeof error.stderr === "string" ? error.stderr : ""}`.slice(-1024 * 1024));
          throw new InstallError(code);
        }
      };
      await buildStep("DEPENDENCY_INSTALL_FAILED", () => run("runuser", ["--user", user, "--", "npm", "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd, env: buildEnv, timeout: 20 * 60 * 1000 }));
      await buildStep("LMS_BUILD_FAILED", () => asUser([path.join(cwd, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd, env: buildEnv, timeout: 45 * 60 * 1000 }));
      demand((await fs.stat(path.join(cwd, ".next/BUILD_ID"))).size > 0, "LMS_BUILD_MISSING");
    },
    async initialize() {
      if (input.maintenanceUrl || input.databaseMode === "local_peer") {
        let result;
        let temporary;
        try {
          const peer = input.databaseMode === "local_peer";
          let executable = process.execPath, args = [path.join(releaseRoot, "backend/runtime-provision.cjs")];
          if (peer) {
            // PostgreSQL peer auth runs as postgres, without reading/resetting its admin password.
            // Copy only the self-contained, verified CLI, never the vault or client secrets.
            const base = "/run/lms-core/provision"; await safeDirectory(base, true);
            const candidate = path.join(base, job.id); await fs.mkdir(candidate, { mode: 0o750 }); temporary = candidate;
            await fs.chmod(candidate, 0o750);
            await fs.copyFile(args[0], path.join(temporary, "provision.cjs")); await fs.chmod(path.join(temporary, "provision.cjs"), 0o640);
            await run("chgrp", ["-R", "postgres", temporary]);
            executable = "runuser"; args = ["--user", "postgres", "--", process.execPath, path.join(temporary, "provision.cjs")];
          }
          result = JSON.parse((await run(executable, args, { input: JSON.stringify({ ...(peer ? { localPeer: true } : { maintenanceUrl: input.maintenanceUrl }), password: input.databasePassword, clientId: job.client.id, jobId: job.id }), timeout: 60000 })).stdout);
        } catch (error) {
          let failure;
          try { failure = JSON.parse(error.stderr || "{}"); } catch {}
          const allowed = ["DATABASE_LOCAL_PEER_REQUIRED", "DATABASE_PROVISION_ADMIN_REQUIRED", "DATABASE_PROVISION_BUSY", "DATABASE_PROVISION_CONFLICT", "DATABASE_SERVICE_PASSWORD_MISMATCH", "DATABASE_PROVISION_FAILED", "DATABASE_PROVISION_NEEDS_ATTENTION", "DATABASE_PROVISION_INPUT_TIMEOUT", "DATABASE_ROLE_NOT_RESTRICTED", "DATABASE_OWNERSHIP_MISMATCH"];
          throw new InstallError(allowed.includes(failure?.error) ? failure.error : "DATABASE_PROVISION_UNCONFIRMED");
        }
        finally { if (temporary) { await fs.unlink(path.join(temporary, "provision.cjs")).catch(() => {}); await fs.rmdir(temporary).catch(() => {}); } }
        demand(result.provisioned === true && result.clientId === job.client.id && result.jobId === job.id, "DATABASE_PROVISION_UNCONFIRMED");
        delete input.maintenanceUrl; delete input.databasePassword; delete input.databaseMode; input.databaseUrl = secrets.databaseUrl;
      }
      let result;
      try { result = await asUser([path.join(releaseRoot, "backend/runtime-init.cjs")], { env: { ...env("api"), LMS_RUNTIME_CLIENT_CONFIG: JSON.stringify(job.client) } }); }
      catch (error) {
        let code;
        try { code = JSON.parse(error.stderr).error; } catch {}
        const allowed = ["INVALID_CLIENT_CONFIG", "BASELINE_MISMATCH", "INVALID_DATABASE_CONFIG", "DATABASE_NOT_EMPTY", "INSTALLATION_MISMATCH", "SCHEMA_MISMATCH", "DATABASE_INITIALIZATION_FAILED", "INSTALLATION_CLIENT_MISMATCH", "INVALID_DATABASE_CLIENT", "DATABASE_ROLE_NOT_RESTRICTED", "DATABASE_OWNERSHIP_MISMATCH", "DATABASE_ROLE_CHECK_FAILED"];
        throw new InstallError(allowed.includes(code) ? code : "SQL_INITIALIZATION_FAILED");
      }
      let value;
      try { value = JSON.parse(result.stdout); } catch { throw new InstallError("SQL_INITIALIZATION_UNCONFIRMED"); }
      demand(value.initialized === true && value.clientId === job.client.id && value.reused === false, "DATABASE_ALREADY_INITIALIZED_OR_UNCONFIRMED");
    },
    async bootstrap() {
      // Persist the encryption material before any encrypted administrator/content write, including failure paths.
      await preparePrivateFiles();
      if (options.bootstrap) { await options.bootstrap(context, secrets, input); await synchronizeContent(true); delete input.clientAdminPassword; delete input.systemAdminPassword; return; }
      await withPrivateApi(async () => {
        const accounts = Object.fromEntries(["clientAdminLogin", "clientAdminName", "clientAdminPassword", "systemAdminLogin", "systemAdminPassword"].map((key) => [key, input[key]]));
        const response = await fetcher(`http://127.0.0.1:${job.apiPort}/api/lms-runtime/v1/bootstrap`, { method: "POST", headers: { Authorization: `Bearer ${secrets.serviceToken}`, "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(accounts), signal: AbortSignal.timeout(15000) });
        demand(response.ok && (await response.json()).initialized === true, "BOOTSTRAP_FAILED");
        await synchronizeContent(true);
      }, true);
      delete input.clientAdminPassword; delete input.systemAdminPassword;
    },
    async configure() {
      await preparePrivateFiles();
      await fs.symlink(releaseRoot, path.join(root, "current"), process.platform === "win32" ? "junction" : "dir");
      for (const [index, role] of ["api", "web"].entries()) {
        const unit = path.join(units, unitNames[index]);
        const contents = `[Unit]\nDescription=LMS Core ${role}\nAfter=network-online.target\n[Service]\nType=simple\nUser=${user}\nGroup=${user}\nWorkingDirectory=${releaseRoot}\nExecStart=${process.execPath} ${path.join(releaseRoot, "backend/runtime-process.cjs")} ${path.join(shared, "runtime-context.json")} ${role}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nUMask=0077\nTimeoutStopSec=20\n[Install]\nWantedBy=multi-user.target\n`;
        await fs.writeFile(unit, contents, { flag: "wx", mode: 0o644 }); createdUnits.push(unit);
      }
    },
    async activate() {
      await freePort(job.apiPort); await freePort(job.webPort);
      await run("systemctl", ["daemon-reload"]);
      for (const name of unitNames) await run("systemctl", ["enable", "--now", name]);
    },
    async health() {
      await poll(async () => {
        const response = await fetcher(`http://127.0.0.1:${job.webPort}/api/core-runtime/health`, { signal: AbortSignal.timeout(3000) });
        const value = await response.json();
        return response.ok && value.protocol === "lms-core-client-v1" && value.clientId === job.client.id && value.releaseId === job.releaseId && value.storage === "postgresql-runtime";
      }, options.healthTimeout || 45000);
      for (const name of unitNames) await run("systemctl", ["is-active", "--quiet", name]);
      await synchronizeContent(false);
    },
    async commit() {
      await fs.writeFile(marker, JSON.stringify({ jobId: job.id, clientId: job.client.id, releaseId: job.releaseId, state: "installed", localUrl: `http://127.0.0.1:${job.webPort}`, services: unitNames }), { mode: 0o600 });
      committed = true;
    },
    async cleanup() {
      if (committed) return;
      let failed = false;
      for (const unit of createdUnits.reverse()) {
        try { await run("systemctl", ["disable", "--now", path.basename(unit)]); await fs.unlink(unit); } catch { failed = true; }
      }
      if (createdUnits.length) try { await run("systemctl", ["daemon-reload"]); } catch { failed = true; }
      demand(!failed, "OWN_SERVICE_CLEANUP_FAILED");
    }
  };
}

async function readSecretInput(stream, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let raw = "", settled = false;
    const cleanup = () => { clearTimeout(timer); stream.off("data", onData); stream.off("end", onEnd); stream.off("error", onError); };
    const finish = (error, value) => { if (settled) return; settled = true; cleanup(); raw = ""; if (error) { stream.destroy(); reject(error); } else resolve(value); };
    const onData = (chunk) => { raw += chunk.toString("utf8"); if (Buffer.byteLength(raw) > 65536) finish(new InstallError("SECRET_INPUT_TOO_LARGE")); };
    const onEnd = () => { try { finish(null, validateSecrets(JSON.parse(raw))); } catch { finish(new InstallError("INVALID_SECRET_INPUT")); } };
    const onError = () => finish(new InstallError("SECRET_INPUT_FAILED"));
    const timer = setTimeout(() => finish(new InstallError("SECRET_INPUT_TIMEOUT")), timeout);
    stream.on("data", onData); stream.once("end", onEnd); stream.once("error", onError);
  });
}

async function main() {
  demand(process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  demand(process.argv.length === 5, "EXPECTED_JOB_AND_PACKAGE_ARGUMENTS");
  const jobFile = path.resolve(process.argv[3]), packageRoot = path.resolve(process.argv[4]);
  demand(process.argv[2] === "--job", "EXPECTED_JOB_AND_PACKAGE_ARGUMENTS");
  const job = validateJob(JSON.parse(await fs.readFile(jobFile, "utf8")));
  const jobDirectory = path.dirname(jobFile);
  demand(jobFile === `/srv/lms-core/jobs/${job.id}/job.json`, "INVALID_JOB_DIRECTORY");
  await safeDirectory(jobDirectory, false);
  const directoryStat = await fs.lstat(jobDirectory), jobStat = await fs.lstat(jobFile);
  demand(directoryStat.uid === 0 && (directoryStat.mode & 0o077) === 0 && jobStat.isFile() && !jobStat.isSymbolicLink() && jobStat.uid === 0 && (jobStat.mode & 0o077) === 0, "JOB_PERMISSIONS_REQUIRED");
  await fs.writeFile(path.join(jobDirectory, ".new-install.lock"), JSON.stringify({ id: job.id }), { flag: "wx", mode: 0o600 });
  const statusFile = path.join(jobDirectory, "new-install-status.json");
  const events = [];
  await fs.writeFile(statusFile, JSON.stringify({ id: job.id, phase: "starting", events }), { flag: "wx", mode: 0o600 });
  const persist = (value) => {
    const temporary = `${statusFile}.${job.id}.tmp`;
    syncFs.writeFileSync(temporary, JSON.stringify({ id: job.id, releaseId: job.releaseId, clientId: job.client.id, ...value, events }), { flag: "wx", mode: 0o600 });
    syncFs.renameSync(temporary, statusFile);
  };
  let secrets;
  try { secrets = await readSecretInput(process.stdin); }
  catch (error) { persist({ phase: "failed", errorCode: error instanceof InstallError ? error.code : "INVALID_SECRET_INPUT" }); throw error; }
  const driver = createInstallDriver(job, secrets, packageRoot);
  const result = await executeNewInstall(driver, (phase) => { events.push({ phase, at: new Date().toISOString() }); persist({ phase }); });
  persist(result);
  process.stdout.write(`${JSON.stringify({ id: job.id, ...result })}\n`);
  if (result.phase !== "succeeded") process.exitCode = 1;
}
module.exports = { executeNewInstall, createInstallDriver, verifyPackage, validateJob, validateSecrets, readSecretInput, stopPrivateGroup, InstallError };
if (require.main === module) void main().catch((error) => { process.stderr.write(`${JSON.stringify({ phase: "failed", errorCode: error instanceof InstallError ? error.code : "NEW_INSTALL_CONFIGURATION_FAILED" })}\n`); process.exitCode = 1; });
