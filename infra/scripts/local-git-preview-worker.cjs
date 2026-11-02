"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { randomUUID, randomBytes } = require("node:crypto");
const { createRequire } = require("node:module");
const { roleEnvironment } = require("./runtime-process.cjs");

// This worker owns only one disposable, empty local tenant. It never receives SSH credentials.
async function runPreview(input, report, cancelled) {
  const root = path.resolve(__dirname, "../.."), db = require(path.join(root, "packages/db/dist/src/index.js"));
  const postgres = createRequire(path.join(root, "packages/db/package.json"))("postgres");
  const maintenance = new URL(input.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(maintenance.protocol) || maintenance.hostname !== "127.0.0.1" || maintenance.port !== "55432") throw Error("LOCAL_DATABASE_REQUIRED");
  maintenance.pathname = "/postgres";
  const tenantId = randomUUID(), jobId = randomUUID(), password = randomBytes(32).toString("base64url");
  const names = db.clientDatabaseNames(tenantId), marker = `lms-core-db-v1:${tenantId}:${jobId}`;
  const work = path.join(root, "infra/runtime", `p-${jobId.slice(0, 12)}`), app = path.join(work, "lms");
  const processes = new Map();
  const check = () => { if (cancelled()) throw Error("PREVIEW_CANCELLED"); };
  let provisioned = false, ready = false;
  const send = (phase, message, extra = {}) => report({ phase, message, ...extra });
  const launch = (script, args, cwd, env) => {
    check();
    const child = spawn(process.execPath, [script, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    // Source output may contain secrets; do not forward it into renderer logs or persist it.
    child.stdout.resume(); child.stderr.resume();
    const ended = new Promise((resolve) => { child.once("error", () => resolve(-1)); child.once("exit", (code) => resolve(code ?? -1)); });
    processes.set(child, ended);
    return { child, ended };
  };
  const stop = async ({ child, ended }) => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      // Kill only this worker's child tree, including Next build subprocesses on Windows.
      if (process.platform === "win32") await new Promise((resolve) => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15000 }, () => resolve()));
      else child.kill();
    }
    let timer;
    try { await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("PREVIEW_STOP_TIMEOUT")), 20000); })]); }
    finally { clearTimeout(timer); }
    processes.delete(child);
  };
  const port = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value;
  };
  const wait = async (handle, callback) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      check();
      if (handle.child.exitCode !== null || handle.child.signalCode !== null) throw Error("PREVIEW_PROCESS_EXITED");
      try { if (await callback()) return; } catch { /* Retry only the read-only readiness request. */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw Error("PREVIEW_READINESS_TIMEOUT");
  };
  try {
    send("preparing", "Проверяю установочный пакет Git-LMS...");
    const payload = path.join(root, "infra/runtime/installation-packages", input.package.id, "payload");
    await require("./lms-new-install-worker.cjs").verifyPackage(payload, input.package.id);
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(payload), "manifest.json"), "utf8"));
    const custom = input.presentationMode === "custom";
    if (!["source", "custom"].includes(input.presentationMode) || manifest.sourceId !== input.package.sourceId || manifest.revision !== input.package.revision ||
      (custom ? !manifest.design || manifest.design.clientId !== input.client.id || manifest.design.sha256 !== input.package.design?.sha256 : !!manifest.design || !!input.package.design)) throw Error("PREVIEW_PACKAGE_MISMATCH");
    await fs.mkdir(work);
    await fs.writeFile(path.join(work, "preview-owner.json"), JSON.stringify({ kind: "local-git-preview-v1", tenantId, jobId, representedClientId: input.client.id, database: names.database, role: names.role, presentationMode: input.presentationMode, releaseId: input.package.id }));
    await fs.cp(path.join(payload, "lms"), app, { recursive: true });
    const dependencies = path.join(root, "infra/runtime/runtime-adapted-sources", input.package.sourceId, "source/node_modules");
    if (!(await fs.stat(path.join(dependencies, "next/dist/bin/next"))).isFile()) throw Error("PREVIEW_DEPENDENCIES_MISSING");
    await fs.symlink(dependencies, path.join(app, "node_modules"), "junction");
    // Keep installation/snapshot immutable; only the preview copy uses a new database identity.
    let designSha256;
    if (custom) {
      const contract = require(path.join(app, "core-client-design-contract.cjs"));
      const design = contract.validateClientDesign(JSON.parse(await fs.readFile(path.join(app, "core-client-design.json"), "utf8")));
      if (contract.designHash(design) !== manifest.design.sha256 || design.clientId !== input.client.id) throw Error("PREVIEW_DESIGN_MISMATCH");
      design.clientId = tenantId;
      await fs.writeFile(path.join(app, "core-client-design.json"), JSON.stringify(design));
      designSha256 = contract.designHash(design);
    } else {
      // Source mode must not acquire a hidden stylesheet/document from a previous preview.
      for (const file of ["core-client-design.json", "app/components/CoreClientDesign.tsx"]) {
        if (await fs.stat(path.join(app, file)).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) throw Error("PREVIEW_UNEXPECTED_DESIGN");
      }
    }
    const configPath = path.join(app, "next.config.ts"), config = await fs.readFile(configPath, "utf8");
    if (!config.includes("const nextConfig: NextConfig = {") || !config.includes("outputFileTracingRoot: projectRoot")) throw Error("PREVIEW_CONFIG_UNSUPPORTED");
    await fs.writeFile(configPath, config.replace("outputFileTracingRoot: projectRoot", `outputFileTracingRoot: ${JSON.stringify(root)}`).replace("const nextConfig: NextConfig = {", `const nextConfig: NextConfig = {\n  experimental: { cpus: 1 },\n  turbopack: { root: ${JSON.stringify(root)} },`));
    check();
    const context = { clientId: tenantId, releaseId: input.package.id, ...(designSha256 ? { designSha256 } : {}), apiPort: await port(), webPort: await port() };
    const secrets = { databaseUrl: db.clientDatabaseUrl(maintenance.href, tenantId, password), serviceToken: randomBytes(32).toString("base64url"), encryptionKey: randomBytes(32).toString("hex"), authSecret: randomBytes(48).toString("base64url") };
    const admins = { clientAdminLogin: "preview.admin", clientAdminName: input.client.name, clientAdminPassword: randomBytes(24).toString("base64url"), systemAdminLogin: "preview.system", systemAdminPassword: randomBytes(24).toString("base64url") };
    const apiEnv = roleEnvironment(context, secrets, "api"), webEnv = roleEnvironment(context, secrets, "web");
    const cli = path.join(app, "node_modules/next/dist/bin/next");
    send("building", "Собираю настоящий интерфейс Git-LMS. Первый запуск может занять несколько минут...");
    const build = launch(cli, ["build"], app, { ...webEnv, NODE_OPTIONS: "--max-old-space-size=3072" });
    const buildDeadline = Date.now() + 8 * 60 * 1000;
    while (build.child.exitCode === null && build.child.signalCode === null) {
      check(); if (Date.now() > buildDeadline) throw Error("PREVIEW_BUILD_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (await build.ended !== 0) throw Error("PREVIEW_BUILD_FAILED");
    processes.delete(build.child);
    send("starting", "Создаю пустую локальную БД и запускаю LMS...");
    await db.provisionClientDatabase(maintenance.href, { clientId: tenantId, jobId, password }); provisioned = true;
    const sql = await fs.readFile(path.join(root, "packages/db/install-baseline/0000_core_runtime_v1.sql"), "utf8");
    const spec = JSON.parse(await fs.readFile(path.join(root, "packages/db/install-baseline/baseline-spec.json"), "utf8"));
    await db.initializeFreshDatabase(secrets.databaseUrl, { sql, version: spec.version, sha256: spec.sha256, schemaSha256: spec.schemaSha256 }, { ...input.client, id: tenantId });
    const apiScript = path.join(payload, "backend/runtime-api.cjs"), api = `http://127.0.0.1:${context.apiPort}/api/lms-runtime/v1`;
    let apiHandle = launch(apiScript, [], path.dirname(apiScript), { ...apiEnv, LMS_RUNTIME_BOOTSTRAP_ENABLED: "true" });
    const apiHealth = async () => (await fetch(`${api}/health`, { headers: { Authorization: `Bearer ${secrets.serviceToken}` }, signal: AbortSignal.timeout(2000) })).ok;
    await wait(apiHandle, apiHealth);
    const bootstrap = await fetch(`${api}/bootstrap`, { method: "POST", headers: { Authorization: `Bearer ${secrets.serviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify(admins), signal: AbortSignal.timeout(15000) });
    if (!bootstrap.ok) throw Error("PREVIEW_BOOTSTRAP_FAILED");
    await stop(apiHandle); apiHandle = launch(apiScript, [], path.dirname(apiScript), apiEnv); await wait(apiHandle, apiHealth);
    const webHandle = launch(cli, ["start", "--hostname", "127.0.0.1", "--port", String(context.webPort)], app, webEnv);
    const url = `http://127.0.0.1:${context.webPort}`;
    await wait(webHandle, async () => {
      const response = await fetch(`${url}/api/core-runtime/health`, { signal: AbortSignal.timeout(2000) }), value = await response.json();
      return response.ok && value.protocol === "lms-core-client-v1" && value.clientId === tenantId && value.releaseId === input.package.id && value.storage === "postgresql-runtime";
    });
    ready = true;
    // Auth is scoped to this new empty tenant and travels only over the private parent IPC channel.
    report({ type: "credentials", admins });
    send("ready", `${custom ? "Git-LMS с явно выбранным оформлением" : "Исходный Git-вид LMS"} запущен локально. Тестовые данные удалятся при остановке или закрытии Core.`, { url });
    while (!cancelled()) {
      if (webHandle.child.exitCode !== null || apiHandle.child.exitCode !== null || webHandle.child.signalCode !== null || apiHandle.child.signalCode !== null) throw Error("PREVIEW_PROCESS_EXITED");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    await Promise.all([...processes].map(([child, ended]) => stop({ child, ended })));
    // Drop only names and exact markers generated in this invocation. A conflicting database is left intact.
    const admin = postgres(maintenance.href, { max: 1, connect_timeout: 5, connection: { statement_timeout: 10000 }, onnotice: () => {} });
    try {
      const [database] = await admin`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=${names.database}`;
      if (database) {
        if (![`${marker}:ready`, `${marker}:pending`].includes(database.marker)) throw Error("PREVIEW_CLEANUP_OWNERSHIP");
        await admin.unsafe(`DROP DATABASE "${names.database}" WITH (FORCE)`);
      }
      const [role] = await admin`SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=${names.role}`;
      if (role) { if (role.marker !== marker) throw Error("PREVIEW_CLEANUP_OWNERSHIP"); await admin.unsafe(`DROP ROLE "${names.role}"`); }
      // Do not recursively delete source/build trees here; retain a non-secret receipt for diagnostics.
      await fs.writeFile(path.join(work, "preview-result.json"), JSON.stringify({ stoppedAt: new Date().toISOString(), ready, provisioned, cleanupCompleted: true })).catch(() => {});
      // The exact random workspace and ownership receipt are checked before deleting only its app copy.
      const owner = JSON.parse(await fs.readFile(path.join(work, "preview-owner.json"), "utf8").catch(() => "null"));
      if (owner?.jobId === jobId && owner.tenantId === tenantId && path.dirname(work) === path.join(root, "infra/runtime") && /^p-[a-f0-9-]{12}$/.test(path.basename(work)) && await fs.realpath(work) === work) {
        const link = path.join(app, "node_modules");
        try { if ((await fs.lstat(link)).isSymbolicLink()) await fs.unlink(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const info = await fs.lstat(app).catch(() => null);
        if (info?.isDirectory() && !info.isSymbolicLink() && await fs.realpath(app) === path.join(work, "lms")) await fs.rm(app, { recursive: true, force: true, maxRetries: 3 });
      }
    } finally { await admin.end({ timeout: 5 }); }
  }
}

module.exports = { runPreview };
if (require.main === module) {
  let running = false, cancelled = false;
  const report = (value) => { if (process.connected) process.send(value); };
  process.on("disconnect", () => { cancelled = true; });
  process.on("message", (value) => {
    if (value?.type === "stop") { cancelled = true; return; }
    if (value?.type !== "start" || running) return;
    running = true;
    void runPreview(value.input, report, () => cancelled).then(() => { report({ phase: "stopped", message: "Локальный просмотр остановлен; тестовая БД удалена." }); if (process.connected) process.disconnect(); }, (error) => { report({ phase: error.message === "PREVIEW_CANCELLED" ? "stopped" : "failed", message: error.message === "PREVIEW_CANCELLED" ? "Запуск отменён; тестовая БД очищена." : "Локальный Git-просмотр не запущен. Проверьте PostgreSQL и принятую сборку исходника.", code: /^[A-Z_]+$/.test(error.message) ? error.message : "PREVIEW_FAILED" }); if (process.connected) process.disconnect(); process.exitCode = 1; });
  });
}
