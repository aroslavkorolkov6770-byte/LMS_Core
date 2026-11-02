"use strict";
const { app, BrowserWindow, dialog, safeStorage } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), net = require("node:net"), { execFile } = require("node:child_process");
const resources = app.isPackaged ? process.resourcesPath : process.env.CORE_DESKTOP_RESOURCES;
const smoke = process.argv.includes("--core-installer-smoke");
let cleanupOnFailure;
app.setName("LMS Core Desktop");
if (smoke && !process.env.CORE_DESKTOP_TEST_DATA) throw Error("DESKTOP_TEST_PROFILE_REQUIRED");
app.setPath("userData", (!app.isPackaged || smoke) && process.env.CORE_DESKTOP_TEST_DATA ? path.resolve(process.env.CORE_DESKTOP_TEST_DATA) : path.join(app.getPath("appData"), "LMS Core Desktop"));
// This lock protects first-run file/database initialization as well as the application window.
const locked = app.requestSingleInstanceLock();
if (!locked) { app.quit(); } else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  void app.whenReady().then(start).catch(async error => {
    let cleanupConfirmed = true;
    try { if (cleanupOnFailure) await cleanupOnFailure(); } catch { cleanupConfirmed = false; }
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.appendFile(path.join(app.getPath("userData"), "desktop-startup.log"), new Date().toISOString() + " " + (error.code || "DESKTOP_START_FAILED") + "\n");
    if (smoke) await fs.writeFile(path.join(app.getPath("userData"), "failure-cleanup.json"), JSON.stringify({ code: error.code || "DESKTOP_START_FAILED", cleanupConfirmed, checkedAt: new Date().toISOString() }));
    if (!smoke && (app.isPackaged || !process.env.CORE_DESKTOP_TEST_DATA)) await dialog.showMessageBox({ type: "error", title: "LMS Core", message: "Не удалось подготовить LMS Core.", detail: "Код: " + (error.code || "DESKTOP_START_FAILED") + ". Существующие данные не удалены. Журнал: " + path.join(app.getPath("userData"), "desktop-startup.log") });
    app.quit();
  });
}

async function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout) => {
      if (error) reject(Object.assign(Error("DESKTOP_COMMAND_FAILED"), { code: options.failure || "DESKTOP_COMMAND_FAILED" }));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {}); child.stdin.end(options.input || "");
  });
}
async function freePort(preferred, excluded = []) {
  const tryPort = port => new Promise(resolve => {
    const socket = net.createServer(); socket.once("error", () => resolve(null));
    socket.listen(port, "127.0.0.1", () => { const value = socket.address().port; socket.close(() => resolve(value)); });
  });
  const candidate = excluded.includes(preferred) ? null : await tryPort(preferred);
  if (candidate) return candidate;
  for (let i = 0; i < 20; i++) { const value = await tryPort(0); if (value && !excluded.includes(value)) return value; }
  throw Error("DESKTOP_PORT_UNAVAILABLE");
}
async function start() {
  if (process.platform !== "win32" || !resources) throw Error("DESKTOP_WINDOWS_REQUIRED");
  const splash = new BrowserWindow({ width: 520, height: 190, resizable: false, autoHideMenuBar: true, backgroundColor: "#141a22", webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<body style="background:#141a22;color:#edf3fa;font:16px Segoe UI;padding:25px"><h2 style="font-size:22px">LMS Core</h2><div id="status">Подготавливаем приложение…</div></body>'));
  if (!smoke) splash.show();
  const status = message => { if (!splash.isDestroyed()) void splash.webContents.executeJavaScript("document.getElementById('status').textContent=" + JSON.stringify(message)); };
  const tools = path.join(resources, "tools"), node = path.join(tools, "node", "node.exe"), pg = path.join(tools, "postgres", "bin"), git = path.join(tools, "git");
  const bundle = path.join(resources, "workspace"), logicalRoot = path.join(app.getPath("userData"), "workspace");
  await fs.mkdir(logicalRoot, { recursive: true });
  // Use the physical path even when the launching app is an MSIX package with redirected AppData.
  const root = (await run(node, ["-e", "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))", logicalRoot])).trim();
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, "desktop-bundle.json"), "utf8"));
  if (manifest.format !== "lms-core-desktop-v1") throw Error("DESKTOP_BUNDLE_INVALID");
  const stamp = path.join(root, ".desktop-bundle-id");
  let current; try { current = await fs.readFile(stamp, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (current !== manifest.id) {
    status("Первый запуск: готовим файлы и библиотеки…");
    await fs.mkdir(root, { recursive: true });
    await fs.cp(bundle, root, { recursive: true });
    await fs.writeFile(stamp, manifest.id);
  }
  await fs.copyFile(path.join(bundle, "desktop-bundle.json"), path.join(root, "desktop-bundle.json"));
  // Plain Node resolves native Windows package-virtualization paths; Electron's ASAR wrapper does not.
  await run(node, [app.isPackaged ? path.join(resources, "dependency-bundle.cjs") : path.join(__dirname, "dependency-bundle.cjs"), root], { failure: "DESKTOP_DEPENDENCY_LINK_FAILED" });
  process.env.PATH = [path.dirname(node), path.join(git, "cmd"), path.join(git, "usr/bin"), pg, process.env.PATH].join(path.delimiter);
  process.env.CORE_DESKTOP_MODE = "1";
  process.env.CORE_PG_BIN = pg; process.env.CORE_GIT_PATH = path.join(git, "cmd/git.exe");
  process.env.CORE_SSH_PATH = path.join(git, "usr/bin/ssh.exe"); process.env.CORE_KEYGEN_PATH = path.join(git, "usr/bin/ssh-keygen.exe");
  process.env.CORE_NEXT_DIST_DIR = ".next-desktop";
  const edge = [path.join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"), path.join(process.env.ProgramFiles || "C:/Program Files", "Microsoft/Edge/Application/msedge.exe")];
  for (const file of edge) { try { await fs.access(file); process.env.CORE_TEST_BROWSER = file; break; } catch {} }
  const configPath = path.join(root, "apps/control-center/config/launcher-config.json"), secretPath = path.join(app.getPath("userData"), "desktop-secrets.bin");
  let config;
  try { config = JSON.parse(await fs.readFile(configPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!safeStorage.isEncryptionAvailable()) throw Error("DESKTOP_SECRET_STORAGE_UNAVAILABLE");
  let secrets;
  try { secrets = JSON.parse(safeStorage.decryptString(await fs.readFile(secretPath))); }
  catch (error) { if (error.code !== "ENOENT") throw Object.assign(Error("DESKTOP_SECRET_READ_FAILED"), { code: "DESKTOP_SECRET_READ_FAILED" }); }
  if (!secrets) {
    if (config) throw Object.assign(Error("DESKTOP_SECRET_MISSING"), { code: "DESKTOP_SECRET_MISSING" });
    secrets = { databasePassword: crypto.randomBytes(32).toString("base64url"), aiEncryption: crypto.randomBytes(32).toString("hex"), storageEncryption: crypto.randomBytes(32).toString("hex") };
    await fs.writeFile(secretPath, safeStorage.encryptString(JSON.stringify(secrets)), { flag: "wx" });
  }
  if (!config) {
    const databasePort = await freePort(smoke ? 0 : 55432), apiPort = await freePort(smoke ? 0 : 3001, [databasePort]), panelPort = await freePort(smoke ? 0 : 3002, [databasePort, apiPort]);
    config = { workspaceRoot: root, environment: { API_PORT: String(apiPort), API_HOST: "127.0.0.1", DEPLOY_PANEL_API_URL: `http://127.0.0.1:${apiPort}`, PRIVATE_STORAGE_ROOT: path.join(root, "infra/private-storage") },
      services: [{ id: "postgres", label: "PostgreSQL", kind: "postgres", port: databasePort, url: "", logFile: path.join(root, "infra/local-postgres/postgres.log") },
        { id: "api", label: "Backend API", kind: "pnpm", command: "pnpm --dir apps/api start", port: apiPort, url: `http://127.0.0.1:${apiPort}/api/health` },
        { id: "deploy-panel", label: "Deploy Panel", kind: "pnpm", command: "pnpm --dir apps/deploy-panel start", port: panelPort, url: `http://127.0.0.1:${panelPort}` }] };
    await fs.mkdir(path.dirname(configPath), { recursive: true }); await fs.writeFile(configPath, JSON.stringify(config, null, 2), { flag: "wx" });
  }
  const databasePort = config.services.find(item => item.id === "postgres").port;
  process.env.DATABASE_URL = `postgresql://core_local:${secrets.databasePassword}@127.0.0.1:${databasePort}/lms_core`;
  process.env.AI_HISTORY_ENCRYPTION_KEY = secrets.aiEncryption; process.env.DOCUMENT_STORAGE_ENCRYPTION_KEY = secrets.storageEncryption;
  const data = path.join(root, "infra/local-postgres/data");
  try { await fs.access(path.join(data, "PG_VERSION")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    status("Создаём вашу пустую локальную базу…");
    await fs.mkdir(path.dirname(data), { recursive: true });
    const pass = path.join(path.dirname(data), "init-" + crypto.randomUUID() + ".tmp");
    try {
      await fs.writeFile(pass, secrets.databasePassword, { flag: "wx" });
      await run(path.join(pg, "initdb.exe"), ["-D", data, "-U", "core_local", "--pwfile", pass, "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--locale=C"], { failure: "DESKTOP_INITDB_FAILED" });
    } finally { await fs.unlink(pass).catch(() => {}); }
    await fs.appendFile(path.join(data, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${databasePort}\n`);
  }
  const attempted = new Set();
  const serviceResult = (output, service) => output.trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line.replace(/^\uFEFF/, ""))]; } catch { return []; } }).find(value => value.id === service);
  cleanupOnFailure = async () => {
    let failed = false;
    for (const service of [...attempted].reverse()) {
      try {
        const output = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "infra/scripts/control-dev-service.ps1"), "-Action", "Stop", "-ServiceId", service], { cwd: root });
        const result = serviceResult(output, service);
        if (!result || result.running || result.ok === false) failed = true;
      } catch { failed = true; }
    }
    if (failed) throw Error("DESKTOP_CLEANUP_INCOMPLETE");
  };
  const action = async (command, service) => {
    if (command === "Start") attempted.add(service);
    const output = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "infra/scripts/control-dev-service.ps1"), "-Action", command, "-ServiceId", service], { cwd: root, failure: "DESKTOP_SERVICE_" + service.toUpperCase().replaceAll("-", "_") });
    const result = serviceResult(output, service);
    if (!result || result.ok === false || result.running !== (command === "Start")) throw Object.assign(Error("DESKTOP_SERVICE_START_FAILED"), { code: "DESKTOP_SERVICE_" + service.toUpperCase().replaceAll("-", "_") });
    if (command === "Stop") attempted.delete(service);
  };
  status("Запускаем локальную PostgreSQL…"); await action("Start", "postgres");
  if (smoke && process.env.CORE_DESKTOP_TEST_FAIL === "database") throw Object.assign(Error("DESKTOP_FIXTURE_FAILURE"), { code: "DESKTOP_FIXTURE_FAILURE" });
  const schemaMarker = path.join(root, "infra/local-postgres/schema-ready.json");
  try { await fs.access(schemaMarker); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const env = { ...process.env, PGPASSWORD: secrets.databasePassword };
    const args = ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(databasePort), "-U", "core_local"];
    const exists = await run(path.join(pg, "psql.exe"), [...args, "-d", "postgres", "-tA", "-c", "SELECT 1 FROM pg_database WHERE datname='lms_core'"], { env });
    if (!exists.trim()) await run(path.join(pg, "createdb.exe"), ["-w", "-h", "127.0.0.1", "-p", String(databasePort), "-U", "core_local", "lms_core"], { env });
    await run(path.join(pg, "psql.exe"), [...args, "-d", "lms_core", "--single-transaction", "-f", path.join(root, "packages/db/install-baseline/0000_core_runtime_v1.sql")], { env, failure: "DESKTOP_SCHEMA_FAILED" });
    await run(node, [path.join(root, "packages/db/node_modules/tsx/dist/cli.mjs"), path.join(root, "packages/db/src/seed/roles.ts")], { cwd: root, failure: "DESKTOP_ROLES_FAILED" });
    await fs.writeFile(schemaMarker, JSON.stringify({ version: 1, emptyClients: true, initializedAt: new Date().toISOString() }), { flag: "wx" });
  }
  status("Запускаем API и панель клиентов…"); await action("Start", "api"); await action("Start", "deploy-panel");
  if (smoke) {
    const api = config.services.find(item => item.id === "api"), panel = config.services.find(item => item.id === "deploy-panel");
    const ready = async url => {
      for (let attempt = 0; attempt < 30; attempt++) {
        try { const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" }); if (response.ok) return response; } catch {}
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      throw Object.assign(Error("DESKTOP_HTTP_UNAVAILABLE"), { code: "DESKTOP_HTTP_UNAVAILABLE" });
    };
    const health = await (await ready(api.url)).json();
    if (health.service !== "lms-core-api") throw Error("DESKTOP_API_IDENTITY_INVALID");
    const html = await (await ready(panel.url)).text(), assets = [...new Set([...html.matchAll(/(?:src|href)="([^" ]+\.(?:css|js)(?:\?[^" ]*)?)"/g)].map(match => match[1]))];
    if (!assets.length) throw Error("DESKTOP_PANEL_ASSETS_MISSING");
    for (const asset of assets) await ready(new URL(asset, panel.url).href);
    const counts = await run(path.join(pg, "psql.exe"), ["-X", "-w", "-h", "127.0.0.1", "-p", String(databasePort), "-U", "core_local", "-d", "lms_core", "-tA", "-c", "SELECT (SELECT count(*) FROM clients), (SELECT count(*) FROM roles)"], { env: { ...process.env, PGPASSWORD: secrets.databasePassword } });
    if (counts.trim() !== "0|3") throw Error("DESKTOP_EMPTY_DATABASE_UNCONFIRMED");
    for (const service of ["deploy-panel", "api", "postgres"]) await action("Stop", service);
    await fs.writeFile(path.join(app.getPath("userData"), "acceptance.json"), JSON.stringify({ accepted: true, bundleId: manifest.id, packaged: app.isPackaged, clients: 0, roles: 3, apiHealthy: true, panelAssets: assets.length, secretsEncrypted: true, ownServicesStopped: true, remoteVps: false, checkedAt: new Date().toISOString() }));
    app.quit(); return;
  }
  // The original application obtains the same re-entrant single-instance lock.
  require(path.join(root, "apps/control-center/dist/main.js"));
  cleanupOnFailure = null;
  setTimeout(() => { if (!splash.isDestroyed()) splash.close(); }, 2000);
}
