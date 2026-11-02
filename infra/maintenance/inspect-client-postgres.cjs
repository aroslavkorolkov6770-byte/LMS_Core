"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const { app, safeStorage } = require("electron");

// Use the existing encrypted Core profile; credentials never leave its SSH transport.
app.setPath("userData", path.join(app.getPath("appData"), "@lms-core/control-center"));
const root = path.resolve(__dirname, "../..");
const { ClientServerStore } = require(path.join(root, "apps/control-center/dist/client-servers.js"));
const { ClientInstallationAccessStore } = require(path.join(root, "apps/control-center/dist/client-installation-access.js"));
const { RemoteTargetService } = require(path.join(root, "apps/control-center/dist/remote-target.js"));
let stage = "validate-target";

async function inspectPostgres(input) {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const run = promisify(execFile);
  const checks = {};
  // Only public service metadata and a constant SQL query are read. No env or user data.
  const commands = {
    os: ["cat", ["/etc/os-release"]],
    postgresUser: ["id", ["postgres"]],
    psql: ["sh", ["-c", "command -v psql || true"]],
    packages: ["dpkg-query", ["-W", "-f=${Package}\t${Status}\t${Version}\n", "postgresql*", "libpq*"]],
    clusters: ["pg_lsclusters", ["--no-header"]],
    postgresService: ["systemctl", ["show", "postgresql.service", "--property=LoadState,ActiveState,SubState"]],
    listeners: ["ss", ["-H", "-ltnp"]],
    packageProcesses: ["ps", ["-C", "apt-get,dpkg,http,https", "-o", "comm=,etimes=,stat="]],
    buildProcesses: ["ps", ["-C", "node,npm", "-o", "pid=,ppid=,pcpu=,pmem=,etimes=,stat=,comm="]],
    localPeer: ["runuser", ["-u", "postgres", "--", "psql", "-XAtw", "-h", "/var/run/postgresql", "-p", "5432", "-d", "postgres", "-c", "SELECT current_user, current_database(), current_setting('server_version_num')"]]
  };
  for (const [name, [file, args]] of Object.entries(commands)) {
    try {
      const result = await run(file, args, { timeout: 15000, maxBuffer: 16384, env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", PGCONNECT_TIMEOUT: "5" } });
      checks[name] = { ok: true, output: result.stdout.trim() };
    } catch (error) {
      checks[name] = { ok: false, code: error.code, output: String(error.stderr || "").slice(0, 2048) };
    }
  }
  if (/^[a-f0-9-]{36}$/.test(input.installJobId || "")) {
    const fs = require("node:fs/promises"), directory = `/srv/lms-core/jobs/${input.installJobId}`;
    if (/^\/srv\/lms-core\/clients\/[a-z0-9-]+$/.test(input.appPath || "")) {
      try {
        const file = input.appPath + "/shared/build.private.log", stat = await fs.stat(file);
        const handle = await fs.open(file, "r"), bytes = Buffer.alloc(Math.min(stat.size, 131072));
        try { await handle.read(bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length)); } finally { await handle.close(); }
        const text = bytes.toString("utf8");
        checks.build = { bytes: stat.size, modifiedAt: stat.mtime.toISOString(), signals: ["Compiled successfully", "Failed to compile", "Collecting page data", "Generating static pages", "Type error", "npm error"].filter(value => text.includes(value)) };
      } catch { checks.build = { notAvailable: true }; }
    }
    checks.jobParents = [];
    for (const file of ["/srv", "/srv/lms-core", "/srv/lms-core/jobs"]) {
      try { const stat = await fs.lstat(file); checks.jobParents.push({ path: file, directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), uid: stat.uid, mode: (stat.mode & 0o7777).toString(8) }); }
      catch (error) { checks.jobParents.push({ path: file, code: error.code }); }
    }
    try { checks.installJobFiles = await fs.readdir(directory); }
    catch (error) { checks.installJobFiles = { code: error.code }; }
  }
  if (input.databaseSource) {
    const module = { exports: {} }, started = Date.now();
    new Function("module", "require", input.databaseSource)(module, require);
    checks.exactDatabaseProbe = { result: await module.exports.checkDatabaseAccess({ databaseMode: "local_peer" }), elapsedMs: Date.now() - started, path: process.env.PATH };
  }
  if (/^[a-f0-9-]{36}$/.test(input.preparationId || "")) {
    const fs = require("node:fs/promises"), base = `/srv/lms-core/preparations/${input.preparationId}`;
    try {
      const state = JSON.parse(await fs.readFile(base + "/status.json", "utf8"));
      checks.preparation = Object.fromEntries(["id", "phase", "errorCode", "updatedAt"].map(key => [key, state[key]]));
      const log = await fs.readFile(base + "/private.log", "utf8");
      checks.packageLog = { bytes: Buffer.byteLength(log), signals: ["Temporary failure resolving", "Could not resolve", "Failed to fetch", "Could not connect", "Release file", "404", "Network is unreachable", "Unable to locate package"].filter(signal => log.includes(signal)),
        summary: log.slice(-4096).replace(/https?:\/\/[^\s]+/g, value => { try { return `[repository:${new URL(value).hostname}]`; } catch { return "[repository]"; } }) };
    } catch { checks.preparationReadFailed = true; }
  }
  // Extract only the PM2 application's identity/path. Never return env, argv or stored secrets.
  try {
    const fs = require("node:fs/promises"), dump = JSON.parse(await fs.readFile("/root/.pm2/dump.pm2", "utf8"));
    checks.savedPm2Applications = dump.map(item => ({ name: item.name, cwd: item.pm_cwd, executable: item.pm_exec_path, pid: item.pid }));
    const pid = Number((await fs.readFile("/root/.pm2/pm2.pid", "utf8")).trim());
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    checks.pm2Daemon = { pid, state: stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[0], command: (await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim() };
    checks.pm2Executable = await fs.realpath("/usr/bin/pm2");
  } catch { checks.savedPm2Applications = []; }
  try {
    const fs = require("node:fs/promises");
    checks.oldAppEntries = (await fs.readdir("/var/www/tea-app", { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() }));
    checks.oldAppProcessCwd = await fs.readlink("/proc/205401/cwd");
    checks.oldAppLinks = {};
    for (const name of ["data", ".env.production.local", "public/uploads"]) {
      try { if ((await fs.lstat("/var/www/tea-app/" + name)).isSymbolicLink()) checks.oldAppLinks[name] = await fs.realpath("/var/www/tea-app/" + name); } catch { /* A missing optional uploads directory is valid. */ }
    }
    checks.oldRelease = JSON.parse(await fs.readFile("/var/www/tea-app/.lms-core-release.json", "utf8"));
    const env = await fs.readFile("/var/www/tea-app/.env.production.local", "utf8");
    checks.oldBackend = /^DATA_BACKEND\s*=\s*["']?([a-z_]+)/mi.exec(env)?.[1] || "not-specified";
    const bases = [...new Set(Object.values(checks.oldAppLinks).map(value => value.split("/previous/")[0]).filter(value => value.startsWith("/srv/lms-core/app-")))];
    checks.oldManagedOwners = [];
    for (const base of bases) checks.oldManagedOwners.push({ base, owner: JSON.parse(await fs.readFile(base + "/owner.json", "utf8")) });
    checks.nginxSites = [];
    for (const entry of await fs.readdir("/etc/nginx/sites-enabled", { withFileTypes: true })) {
      const file = "/etc/nginx/sites-enabled/" + entry.name, text = await fs.readFile(file, "utf8");
      checks.nginxSites.push({ file, symlink: entry.isSymbolicLink(), target: await fs.realpath(file), directives: text.split("\n").filter(line => /^\s*(?:listen|server_name|proxy_pass|root|ssl_certificate)\s/.test(line)) });
    }
  } catch { checks.oldAppInventoryIncomplete = true; }
  return { readOnly: true, checkedAt: new Date().toISOString(), checks };
}

app.whenReady().then(async () => {
  const [clientId, expectedHost] = process.argv.slice(2);
  if (!/^[a-f0-9-]{36}$/.test(clientId || "") || !/^[a-z0-9.:-]+$/i.test(expectedHost || "")) throw Error("INVALID_TARGET");
  const state = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/new-deployments", clientId + ".json"), "utf8"));
  if (state.clientId !== clientId || state.target.host !== expectedHost || !state.target.fingerprint || state.target.username !== "root") throw Error("TARGET_CHANGED");
  const protector = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: value => safeStorage.encryptString(value),
    decrypt: value => safeStorage.decryptString(value)
  };
  const store = new ClientServerStore(path.join(app.getPath("userData"), "client-servers"), protector);
  const access = new ClientInstallationAccessStore(path.join(app.getPath("userData"), "installation-access"), protector);
  stage = "saved-profile";
  const remote = new RemoteTargetService(root, undefined, async (target, auth) =>
    (await store.get(clientId, target)).passwordSaved ? store.credentials(target, auth) : access.sshCredentials(target, auth));
  stage = "read-only-ssh";
  if (process.argv.includes("--probe-transport")) {
    const source = await fs.readFile(path.join(root, "infra/scripts/database-preflight.cjs"), "utf8");
    const prefix = `const probe=(()=>{const module={exports:{}};const exports=module.exports;${source}\nreturn module.exports;})();`;
    const old = prefix + `let raw='';process.stdin.on('data',c=>{raw+=c;if(Buffer.byteLength(raw)>16384)process.exit(1)});process.stdin.on('end',()=>{try{probe.checkDatabaseAccess(JSON.parse(raw)).then(r=>process.stdout.write(JSON.stringify(r)))}catch{process.exitCode=1}});`;
    const modern = prefix + `probe.checkDatabaseAccess({databaseMode:'local_peer'}).then(r=>process.stdout.write(JSON.stringify(r))).catch(()=>{process.exitCode=1});`;
    const result = await remote.withSession(state.target, { mode: "password", savedForClient: clientId }, async session => {
      const results = {};
      for (const [name, command, input] of [["existing", `node -e "eval(Buffer.from('${Buffer.from(old).toString("base64")}','base64').toString())"`, JSON.stringify({ databaseMode: "local_peer" })], ["stdinProgram", "node -", modern]]) {
        const started = Date.now();
        try { results[name] = { output: JSON.parse(await session.execute(command, input, 25000)), elapsedMs: Date.now() - started }; }
        catch { results[name] = { failed: true, elapsedMs: Date.now() - started }; }
      }
      return results;
    });
    console.log(JSON.stringify({ readOnly: true, transport: result })); app.quit(); return;
  }
  let preparationId;
  try { preparationId = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/server-preparations", clientId + ".json"), "utf8")).id; } catch { /* No previous preparation is a valid diagnostic state. */ }
  const databaseSource = await fs.readFile(path.join(root, "infra/scripts/database-preflight.cjs"), "utf8");
  const script = `(${inspectPostgres.toString()})(${JSON.stringify({ preparationId, installJobId: state.id, appPath: state.target.appPath, databaseSource })}).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>process.stdout.write(JSON.stringify({readOnly:true,diagnosticFailed:true})));`;
  console.log(await remote.withSession(state.target, { mode: "password", savedForClient: clientId }, session => session.execute("node -", script, 150000)));
  app.quit();
}).catch(error => {
  console.error(JSON.stringify({ readOnly: true, diagnosticFailed: true, stage, code: /^[A-Z_]{1,80}$/.test(error.message || "") ? error.message : "DIAGNOSTIC_FAILED" }));
  app.exit(1);
});
