"use strict";

// This script is sent to the selected server over SSH. It never executes application code.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

function run(file, args) {
  try { return execFileSync(file, args, { encoding: "utf8", timeout: 8000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { return ""; }
}

function mode(value) { return value === "json" || value === "mysql" ? value : "unknown"; }

function environmentMode(text) {
  const match = /^(?:export\s+)?DATA_BACKEND\s*=\s*(.*?)\s*$/m.exec(text);
  if (!match) return null;
  return mode(match[1].replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2").trim());
}

function summarize(file) {
  const result = { path: file, kind: "missing", bytes: 0, files: 0, truncated: false };
  if (!fs.existsSync(file)) return result;
  const top = fs.lstatSync(file);
  if (top.isSymbolicLink()) return { ...result, kind: "symlink" };
  if (top.isFile()) return { ...result, kind: "file", bytes: top.size, files: 1 };
  if (!top.isDirectory()) return { ...result, kind: "other" };
  result.kind = "directory";
  const pending = [{ file, depth: 0 }];
  while (pending.length && !result.truncated) {
    const current = pending.pop();
    if (current.depth > 10) { result.truncated = true; break; }
    for (const entry of fs.readdirSync(current.file, { withFileTypes: true })) {
      if (++result.files > 20000) { result.truncated = true; break; }
      const next = path.join(current.file, entry.name);
      if (entry.isSymbolicLink()) { result.truncated = true; break; }
      if (entry.isDirectory()) pending.push({ file: next, depth: current.depth + 1 });
      else if (entry.isFile()) result.bytes += fs.statSync(next).size;
    }
  }
  return result;
}

function managers(appRoot) {
  const pm2 = [];
  const systemd = [];
  const home = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
  try {
    const pid = Number(fs.readFileSync(path.join(home, "pm2.pid"), "utf8").trim());
    // Calling pm2 without a running daemon can start it. Verify the daemon first.
    if (Number.isSafeInteger(pid) && pid > 1 && /PM2.*God Daemon/i.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"))) {
      const rows = JSON.parse(run("pm2", ["jlist"]) || "[]");
      for (const row of rows) {
        const env = row.pm2_env || {};
        const cwd = typeof env.pm_cwd === "string" ? env.pm_cwd : "";
        const script = typeof env.pm_exec_path === "string" ? env.pm_exec_path : "";
        let sameDirectory = false;
        try { sameDirectory = fs.realpathSync(cwd) === appRoot; } catch {}
        if (!sameDirectory && !script.startsWith(`${appRoot}/`)) continue;
        const port = Number(env.PORT);
        pm2.push({ id: row.pm_id, name: String(row.name || "").slice(0, 150), status: String(env.status || "unknown").slice(0, 40),
          cwd, backend: mode(env.DATA_BACKEND), hasBackendOverride: Object.hasOwn(env, "DATA_BACKEND"),
          port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null });
      }
    }
  } catch { /* Missing or unreadable process metadata is reported as unknown, not guessed. */ }
  const units = run("systemctl", ["list-units", "--type=service", "--state=running", "--no-legend", "--plain"])
    .split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter((name) => /^[a-z0-9_.@-]+\.service$/i.test(name)).slice(0, 100);
  if (units.length) {
    const details = run("systemctl", ["show", "--property=Id", "--property=WorkingDirectory", ...units]);
    for (const block of details.split(/\r?\n\r?\n/)) {
      const id = /^Id=(.*)$/m.exec(block)?.[1];
      const cwd = /^WorkingDirectory=(.*)$/m.exec(block)?.[1];
      if (!id || !cwd) continue;
      try { if (fs.realpathSync(cwd) === appRoot) systemd.push({ name: id, cwd }); } catch {}
    }
  }
  return { pm2, systemd };
}

try {
  const input = JSON.parse(Buffer.from(process.argv[2] || "", "base64").toString("utf8"));
  if (typeof input.appPath !== "string" || !path.isAbsolute(input.appPath)) throw new Error("INVALID_PATH");
  const appRoot = fs.realpathSync(input.appPath);
  const packageFile = path.join(appRoot, "package.json");
  if (fs.statSync(packageFile).size > 512 * 1024) throw new Error("PACKAGE_TOO_LARGE");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const environmentFiles = [];
  let backend = null;
  for (const name of [".env.production.local", ".env.local", ".env.production", ".env"]) {
    const file = path.join(appRoot, name);
    if (!fs.existsSync(file)) continue;
    environmentFiles.push(file);
    if (backend === null && fs.statSync(file).size <= 512 * 1024) backend = environmentMode(fs.readFileSync(file, "utf8"));
  }
  const runtime = managers(appRoot);
  const override = runtime.pm2.filter((row) => row.hasBackendOverride);
  if (override.length && override.every((row) => row.backend === override[0].backend)) backend = override[0].backend;
  if (backend === null) {
    const configFile = path.join(appRoot, "app/lib/database/config.ts");
    if (fs.existsSync(configFile) && fs.statSync(configFile).size < 512 * 1024 && /process\.env\.DATA_BACKEND\s*\|\|\s*['"]json['"]/.test(fs.readFileSync(configFile, "utf8"))) backend = "json";
  }
  const protectedPaths = ["data", "uploads", "public/uploads", "storage"].map((name) => summarize(path.join(appRoot, name))).filter((row) => row.kind !== "missing");
  const warnings = [];
  if (backend === null || backend === "unknown") warnings.push("Режим данных не подтвержден; автоматическое переключение запрещено.");
  if (runtime.pm2.length + runtime.systemd.length !== 1) warnings.push("Не найден единственный управляющий процесс. Перед обновлением нужно точно выбрать службу.");
  if (runtime.systemd.length) warnings.push("Окружение systemd может переопределять режим данных; его нужно проверить без вывода секретов.");
  if (backend === "mysql") warnings.push("Помимо файлов нужен проверенный SQL backup. Миграция/переключение БД не выполнялись.");
  if (protectedPaths.some((row) => row.truncated || row.kind === "symlink")) warnings.push("Данные содержат ссылки или превышают лимит обхода; нужен отдельный план резервного копирования.");
  if (backend === "json" && !protectedPaths.some((row) => row.path === path.join(appRoot, "data"))) warnings.push("Каталог data не найден. Не создавать вместо него пустые данные автоматически.");
  const disk = fs.statfsSync(appRoot);
  const result = { checkedAt: new Date().toISOString(), appRoot, backend: backend || "unknown", environmentFiles, protectedPaths,
    packageManager: fs.existsSync(path.join(appRoot, "package-lock.json")) ? "npm" : "unknown",
    projectKind: pkg.dependencies?.next || pkg.devDependencies?.next ? "nextjs" : "unknown",
    hasBuild: typeof pkg.scripts?.build === "string", hasStart: typeof pkg.scripts?.start === "string",
    managers: runtime, diskFreeBytes: disk.bavail * disk.bsize, memoryTotalBytes: os.totalmem(), memoryFreeBytes: os.freemem(), warnings };
  process.stdout.write(JSON.stringify(result));
} catch {
  // Never print exception text: it can include a fragment of a malformed env/config file.
  process.stderr.write("LMS_PREFLIGHT_FAILED\n");
  process.exitCode = 1;
}
