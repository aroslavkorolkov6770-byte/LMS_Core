"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../../..");
const worker = require(path.join(root, "infra/scripts/uninstall-lms.cjs"));
const publication = require(path.join(root, "infra/scripts/publish-lms-ip.cjs"));
const vault = require(path.join(root, "infra/scripts/runtime-process.cjs"));
const deletion = require(path.join(root, "infra/scripts/delete-client-database.cjs"));
const fullRemoval = require(path.join(root, "infra/scripts/complete-lms-removal.cjs"));
const installer = require(path.join(root, "infra/scripts/lms-new-install-worker.cjs"));
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
async function run(file, args, input = "", env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(Error("LOCAL_REMOVAL_TEST_TIMEOUT")); }, 90000);
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", () => {});
    child.on("error", () => { clearTimeout(timer); reject(Error("LOCAL_REMOVAL_TEST_TOOL_FAILED")); });
    child.on("exit", code => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(Object.assign(Error("LOCAL_REMOVAL_TEST_COMMAND_FAILED"), { exitCode: code, stdout })); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
async function freePort(start) {
  const candidates = start ? Array.from({ length: 40 }, (_, index) => start + index) : [0];
  for (const port of candidates) {
    const server = net.createServer();
    try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); const assigned = server.address().port; await new Promise(resolve => server.close(resolve)); return assigned; }
    catch { server.close(); }
  }
  throw Error("LOCAL_REMOVAL_TEST_NO_FREE_PORT");
}
async function poll(operation) { for (let attempt = 0; attempt < 50; attempt++) { try { return await operation(); } catch { await new Promise(resolve => setTimeout(resolve, 200)); } } throw Error("LOCAL_REMOVAL_TEST_HEALTH_FAILED"); }

async function acceptance() {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const id = crypto.randomUUID(), clientId = crypto.randomUUID(), jobId = crypto.randomUUID(), releaseId = crypto.randomUUID();
  const slug = "removal-test-" + id.slice(0, 12), appPath = "/srv/lms-core/clients/" + slug;
  const fixtureParent = "/var/lib/postgresql/core-removal-fixtures", pgRoot = path.join(fixtureParent, id), data = path.join(pgRoot, "data"), socket = path.join(pgRoot, "socket");
  const backupParent = "/srv/lms-core/backups/" + clientId;
  const nginxParent = "/opt/lms-core-removal-fixtures", nginxRoot = path.join(nginxParent, id), nginxDirectory = path.join(nginxRoot, "conf.d"), nginxMain = path.join(nginxRoot, "nginx.conf");
  const c = { clientId, jobId, releaseId, operationId: crypto.randomUUID(), host: "127.0.0.1", appPath, webPort: await freePort(3050) };
  const context = { clientId, releaseId, releaseRoot: `${appPath}/releases/${releaseId}`, webPort: c.webPort, apiPort: await freePort() };
  const suffix = clientId.replaceAll("-", ""), role = "lms_role_" + suffix, database = "lms_" + suffix, restoredDatabase = "restore_" + suffix;
  const user = "lms-" + hash(Buffer.from(clientId)).slice(0, 20), services = ["api", "web"].map(role => `lms-${slug}-${role}.service`);
  const output = path.join(root, "infra/runtime/local-acceptance/uninstall-20261031", id);
  await fs.mkdir(output, { recursive: true });
  let createdUser = false, createdPg = false, pgRunning = false, createdApp = false, nginxStarted = false, createdNginx = false, result, restoredBackup = false, databaseDrop = false;
  let cleanupJobId = jobId, fullProof = null, reinstallation = null;
  const createdTlsPaths = [];
  const createdUnits = [];
  const major = (await fs.readdir("/usr/lib/postgresql")).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))[0];
  assert.ok(major); const pgBin = `/usr/lib/postgresql/${major}/bin`;
  const pgPort = await freePort();
  const nginxPort = await freePort();
  const isolatedPublication = { ...publication,
    nginxConfiguration: (...args) => publication.nginxConfiguration(...args).replace("listen 80;", `listen ${nginxPort};`),
    nginxHttpsConfiguration: (...args) => publication.nginxHttpsConfiguration(...args).replace("listen 80;", `listen ${nginxPort};`) };
  const nginxFile = path.join(nginxDirectory, `lms-core-${clientId}.conf`);
  const nginxCommand = args => run("nginx", ["-p", nginxRoot + "/", "-c", nginxMain, ...args]);
  const admin = sql => run(path.join(pgBin, "psql"), ["--no-psqlrc", "--no-align", "--tuples-only", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", String(pgPort), "-U", "postgres", "-d", "postgres"], sql);
  const health = async () => { const response = await fetch(`http://127.0.0.1:${c.webPort}/api/core-runtime/health`, { signal: AbortSignal.timeout(2000) }); const body = await response.json(); assert.equal(body.clientId, clientId); assert.equal(body.releaseId, releaseId); return true; };
  try {
    await fs.mkdir(fixtureParent, { recursive: true, mode: 0o755 }); assert.equal((await fs.lstat(fixtureParent)).isSymbolicLink(), false);
    await fs.mkdir(pgRoot, { mode: 0o700 }); createdPg = true;
    await run("chown", ["postgres:postgres", pgRoot]);
    await run("runuser", ["-u", "postgres", "--", path.join(pgBin, "initdb"), "-D", data, "--auth-local=trust", "--auth-host=scram-sha-256", "--encoding=UTF8", "--no-locale"]);
    await fs.mkdir(socket, { mode: 0o700 }); await run("chown", ["postgres:postgres", socket]);
    await run("runuser", ["-u", "postgres", "--", path.join(pgBin, "pg_ctl"), "-D", data, "-l", path.join(pgRoot, "postgres.log"), "-o", `-h 127.0.0.1 -p ${pgPort} -k ${socket}`, "-w", "start"]); pgRunning = true;
    const password = crypto.randomBytes(32).toString("hex");
    const marker = `lms-core-db-v1:${clientId}:${jobId}`;
    await admin(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}';\nCREATE DATABASE ${database} OWNER ${role};\nCOMMENT ON ROLE ${role} IS '${marker}'; COMMENT ON DATABASE ${database} IS '${marker}:ready';\n`);
    await run(path.join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", String(pgPort), "-U", "postgres", "-d", database], `SET ROLE ${role}; CREATE TABLE clients(id uuid PRIMARY KEY, name text); INSERT INTO clients VALUES ('${clientId}','isolated removal acceptance');\n`);
    await run("useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", appPath + "/shared/home", "--shell", "/usr/sbin/nologin", user]); createdUser = true;
    await fs.mkdir(appPath, { mode: 0o750 }); createdApp = true;
    await fs.mkdir(path.join(appPath, "shared"), { mode: 0o750 }); await fs.mkdir(path.join(context.releaseRoot, "backend"), { recursive: true, mode: 0o750 });
    await fs.writeFile(path.join(appPath, ".core-install-owner.json"), JSON.stringify({ clientId, jobId, releaseId, state: "installed", services }), { mode: 0o600 });
    await fs.writeFile(path.join(appPath, "shared/runtime-context.json"), JSON.stringify(context), { mode: 0o640 });
    const key = crypto.randomBytes(32), databaseUrl = `postgresql://${role}:${password}@127.0.0.1:${pgPort}/${database}`;
    await fs.writeFile(path.join(appPath, "shared/runtime-vault.key"), key, { mode: 0o640 });
    await fs.writeFile(path.join(appPath, "shared/runtime-vault.json"), JSON.stringify(vault.sealSecrets({ databaseUrl }, key, clientId)), { mode: 0o640 });
    await fs.writeFile(path.join(appPath, "shared/fixture-upload.bin"), "fixture file survives archive and restore", { mode: 0o640 });
    const source = `const fs=require('node:fs'),http=require('node:http');const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const role=process.argv[3];http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({protocol:'lms-core-client-v1',status:'ok',clientId:c.clientId,releaseId:c.releaseId}));}).listen(role==='web'?c.webPort:c.apiPort,'127.0.0.1');`;
    await fs.writeFile(path.join(context.releaseRoot, "backend/runtime-process.cjs"), source, { mode: 0o640 });
    await fs.symlink(context.releaseRoot, path.join(appPath, "current"));
    await run("chgrp", ["-R", user, appPath]);
    for (const [index, name] of services.entries()) { await fs.writeFile("/etc/systemd/system/" + name, worker.expectedService(context, user, process.execPath, index === 0 ? "api" : "web"), { flag: "wx", mode: 0o644 }); createdUnits.push(name); }
    await run("systemctl", ["daemon-reload"]); await run("systemctl", ["enable", "--now", ...services]); await poll(health);
    await fs.mkdir(nginxParent, { recursive: true, mode: 0o700 }); assert.equal((await fs.lstat(nginxParent)).isSymbolicLink(), false);
    await fs.mkdir(nginxRoot, { mode: 0o700 }); createdNginx = true; await fs.mkdir(nginxDirectory, { mode: 0o700 });
    await fs.writeFile(nginxMain, `pid ${nginxRoot}/nginx.pid; error_log ${nginxRoot}/error.log; events {} http { access_log off; include ${nginxDirectory}/*.conf; }\n`);
    await fs.writeFile(nginxFile, isolatedPublication.nginxConfiguration(c));
    await nginxCommand(["-t"]); await nginxCommand([]); nginxStarted = true;
    await poll(async () => { const response = await fetch(`http://127.0.0.1:${nginxPort}/api/core-runtime/health`, { headers: { Connection: "close" }, signal: AbortSignal.timeout(2000) }); assert.equal((await response.json()).clientId, clientId); });
    console.log("isolated PostgreSQL, two own systemd units and fixture web started");
    const options = { publication: isolatedPublication, unseal: vault.openSecrets, agreement: true, nginxDirectory,
      run: async (file, args, settings = {}) => {
        if (file === "nginx") return nginxCommand(args);
        if (file === "systemctl" && args[0] === "reload" && args[1] === "nginx") return nginxCommand(["-s", "reload"]);
        try { return await run(file, args, "", { ...(settings.env || process.env), PATH: pgBin + ":" + process.env.PATH }); }
        catch (error) { if (settings.allowInactive && [1, 3, 4].includes(error.exitCode)) return error.stdout; throw Object.assign(Error("REMOVAL_COMMAND_FAILED"), { code: "REMOVAL_COMMAND_FAILED" }); }
      } };
    assert.equal((await worker.inspectRemoval(c, options)).phase, "checked");
    result = await worker.uninstallLms(c, options);
    assert.equal(result.phase, "uninstalled", JSON.stringify(result));
    await assert.rejects(fs.stat(appPath));
    await assert.rejects(fs.stat(nginxFile));
    await assert.rejects(fetch(`http://127.0.0.1:${c.webPort}/api/core-runtime/health`, { signal: AbortSignal.timeout(1500) }));
    assert.ok((await admin(`SELECT datname FROM pg_database WHERE datname='${database}';`)).includes(database));
    assert.equal(await fs.readFile(path.join(result.backupPath, "application/shared/fixture-upload.bin"), "utf8"), "fixture file survives archive and restore");
    assert.equal(hash(await fs.readFile(path.join(result.backupPath, "database.dump"))), result.databaseDumpSha256);
    await admin(`CREATE DATABASE ${restoredDatabase};`);
    await run(path.join(pgBin, "pg_restore"), ["--no-owner", "--no-acl", "--exit-on-error", "-h", socket, "-p", String(pgPort), "-U", "postgres", "-d", restoredDatabase, path.join(result.backupPath, "database.dump")]);
    const restored = await run(path.join(pgBin, "psql"), ["-X", "-A", "-t", "-h", socket, "-p", String(pgPort), "-U", "postgres", "-d", restoredDatabase, "-c", "SELECT id FROM clients"]);
    assert.equal(restored.trim(), clientId);
    // Restore only the fixture installation to prove that retained files/units can start again.
    await fs.rename(path.join(result.backupPath, "application"), appPath);
    for (const name of services) await fs.rename(path.join(result.backupPath, "configuration", name), "/etc/systemd/system/" + name);
    await fs.rename(path.join(result.backupPath, "configuration/nginx.conf"), nginxFile);
    await nginxCommand(["-t"]); await nginxCommand(["-s", "reload"]);
    await run("systemctl", ["daemon-reload"]); await run("systemctl", ["enable", "--now", ...services]); await poll(health); restoredBackup = true;
    await poll(async () => { const response = await fetch(`http://127.0.0.1:${nginxPort}/api/core-runtime/health`, { headers: { Connection: "close" }, signal: AbortSignal.timeout(2000) }); assert.equal((await response.json()).clientId, clientId); });
    console.log("real pg_dump/pg_restore, archive, preserved original DB and fixture service restoration accepted");
    if (process.env.CORE_DELETE_ACCEPTANCE === "1" || process.env.CORE_FULL_REMOVAL_ACCEPTANCE === "1") {
      const executeSql = async sql => {
        const output = await run("runuser", ["-u", "postgres", "--", path.join(pgBin, "psql"), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", String(pgPort), "-d", "postgres"], sql);
        return JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('{"database"')));
      };
      const next = { ...c, operationId: crypto.randomUUID() };
      assert.equal((await deletion.checkClientDatabase(next, { unseal: vault.openSecrets, executeSql })).phase, "checked");
      result = await worker.uninstallLms(next, options);
      assert.equal(result.phase, "uninstalled");
      const settings = { agreement: true, unseal: vault.openSecrets, executeSql };
      // A foreign ownership marker must reject DROP while both fixture databases remain.
      await admin(`COMMENT ON DATABASE ${database} IS 'unrelated fixture';`);
      await assert.rejects(deletion.deleteArchivedDatabase(next, settings));
      assert.ok((await admin(`SELECT datname FROM pg_database WHERE datname='${database}';`)).includes(database));
      await admin(`COMMENT ON DATABASE ${database} IS '${marker}:ready';`);
      const dropped = await deletion.deleteArchivedDatabase(next, settings);
      assert.equal(dropped.databaseDeleted, true);
      assert.equal((await admin(`SELECT count(*) FROM pg_database WHERE datname='${database}';`)).trim(), "0");
      assert.equal((await admin(`SELECT count(*) FROM pg_roles WHERE rolname='${role}';`)).trim(), "0");
      assert.equal((await deletion.deleteArchivedDatabase(next, settings)).databaseDeleted, true);
      const retained = await run(path.join(pgBin, "psql"), ["-X", "-A", "-t", "-h", socket, "-p", String(pgPort), "-U", "postgres", "-d", restoredDatabase, "-c", "SELECT id FROM clients"]);
      assert.equal(retained.trim(), clientId); databaseDrop = true;
      console.log("dedicated database and role dropped; replay safe; separate restored database retained");
      if (process.env.CORE_FULL_REMOVAL_ACCEPTANCE === "1") {
        const tls = publication.tlsPaths(next), renewal = publication.renewalConfiguration(next);
        await fs.mkdir(path.dirname(tls.base), { recursive: true, mode: 0o700 }); await fs.mkdir(tls.base, { mode: 0o700 }); createdTlsPaths.push(tls.base);
        await fs.writeFile(tls.base + "/reload-nginx.sh", renewal.files.find(([file]) => file === tls.base + "/reload-nginx.sh")[1], { mode: 0o700 });
        await fs.mkdir(tls.base + "/config/archive/fixture", { recursive: true, mode: 0o700 });
        await fs.mkdir(tls.base + "/config/live/fixture", { recursive: true, mode: 0o700 });
        await fs.writeFile(tls.base + "/config/archive/fixture/key.pem", "not-a-real-key", { mode: 0o600 });
        await fs.symlink("../../archive/fixture/key.pem", tls.base + "/config/live/fixture/privkey.pem");
        await fs.mkdir(path.dirname(tls.webroot), { recursive: true, mode: 0o755 }); await fs.mkdir(tls.webroot, { mode: 0o755 }); createdTlsPaths.push(tls.webroot); await fs.writeFile(tls.webroot + "/fixture.txt", "owned challenge fixture");
        const fullOptions = { archive: worker, database: deletion, publication, unseal: vault.openSecrets, executeSql, archived: true, agreement: true,
          run: async (file, args) => { try { return await run(file, args); } catch (error) { throw Object.assign(Error("FULL_FIXTURE_COMMAND_FAILED"), { exitCode: error.exitCode }); } } };
        assert.equal((await fullRemoval.inspectFullRemoval(next, fullOptions)).phase, "checked");
        const complete = await fullRemoval.completeRemoval(next, fullOptions);
        assert.equal(complete.phase, "uninstalled", JSON.stringify(complete)); assert.equal(complete.databaseDeleted, true); assert.equal(complete.serviceAccountDeleted, true); createdUser = false;
        await assert.rejects(run("getent", ["passwd", user])); await assert.rejects(run("getent", ["group", user]));
        await assert.rejects(fs.stat(tls.base)); await assert.rejects(fs.stat(tls.webroot));
        assert.equal(await fs.readFile(complete.backupPath + "/https/config/live/fixture/privkey.pem", "utf8"), "not-a-real-key");
        assert.equal((await fullRemoval.completeRemoval(next, fullOptions)).phase, "uninstalled");
        console.log("full removal freed SQL, Linux user/group, application path and own certificate resources; retry accepted");
        const pkg = process.env.CORE_ACCEPTANCE_PACKAGE_ID || "ece72471-ceed-4b98-ba79-c38691a711d1";
        assert.match(pkg, /^[a-f0-9-]{36}$/);
        const payload = path.join(root, "infra/runtime/installation-packages", pkg, "payload");
        const newJob = { version: 1, id: crypto.randomUUID(), releaseId: pkg, client: { id: clientId, name: "Reinstall fixture", slug, domain: "fixture.invalid", brandName: "Fixture", tariff: "base", industryTemplate: "coffee_shop", includedUsers: 5, maxAdmins: 2, aiRequestsLimit: 0, primaryColor: null }, apiPort: context.apiPort, webPort: c.webPort };
        const adminPassword = crypto.randomBytes(24).toString("base64url");
        await admin(`ALTER ROLE postgres PASSWORD '${adminPassword}';`);
        let administratorsVerified = false;
        reinstallation = installer.createInstallDriver(newJob, { maintenanceUrl: `postgresql://postgres:${adminPassword}@127.0.0.1:${pgPort}/postgres`, databasePassword: crypto.randomBytes(32).toString("base64url"), clientAdminLogin: "fixture_admin", clientAdminName: "Fixture", clientAdminPassword: crypto.randomBytes(24).toString("base64url"), systemAdminLogin: "fixture_system", systemAdminPassword: crypto.randomBytes(24).toString("base64url") }, payload, {
          fetch: async (url, settings) => {
            const response = await fetch(url, settings);
            if (String(url).endsWith("/bootstrap") && response.ok) {
              assert.equal((await response.clone().json()).userIds.length, 2);
              // Runtime accounts live in encrypted runtime entries, not the normalized users table.
              const stored = await fetch(`http://127.0.0.1:${context.apiPort}/api/lms-runtime/v1/read`, { method: "POST", headers: settings.headers, body: JSON.stringify({ keys: ["core_lms_users_v1"] }), signal: AbortSignal.timeout(15000) });
              assert.equal(stored.ok, true);
              const entry = (await stored.json()).entries[0];
              assert.equal(entry.found, true);
              assert.deepEqual(entry.data.map(account => account.login).sort(), ["fixture_admin", "fixture_system"]);
              assert.ok(entry.data.every(account => typeof account.passHash === "string" && !Object.hasOwn(account, "password")));
              administratorsVerified = true;
            }
            return response;
          }
        });
        await reinstallation.validate(); cleanupJobId = newJob.id; createdUser = true; await reinstallation.reserve();
        await reinstallation.initialize(); await reinstallation.bootstrap();
        assert.equal((await admin(`SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='${database}';`)).trim(), `lms-core-db-v1:${clientId}:${newJob.id}:ready`);
        assert.equal(administratorsVerified, true);
        assert.equal((await run(path.join(pgBin, "psql"), ["-X", "-A", "-t", "-h", socket, "-p", String(pgPort), "-U", "postgres", "-d", restoredDatabase, "-c", "SELECT id FROM clients"])).trim(), clientId);
        fullProof = { version: 2, accepted: true, databaseDeleted: true, serviceAccountDeleted: true, certificatesArchived: true, reinstallReady: true, realReprovisionAndAdmins: true, otherDatabasePreserved: true, backupRestored: true, nextBuildInThisTest: false, remoteVps: false };
        console.log("same client reinstalled through real worker validate/reserve/provision/bootstrap with a new job and two fresh admins");
      }
    }
  } finally {
    if (reinstallation) await reinstallation.cleanup();
    for (const file of createdTlsPaths) {
      assert.ok([`/etc/lms-core/acme/${clientId}`, `/var/www/lms-core-acme/${clientId}`].includes(file));
      assert.equal(path.basename(file), clientId); const stat = await fs.lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (stat) { assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0); await fs.rm(file, { recursive: true }); }
    }
    if (nginxStarted) await nginxCommand(["-s", "quit"]);
    if (createdNginx) { assert.equal(path.dirname(nginxRoot), nginxParent); assert.equal(path.basename(nginxRoot), id); await new Promise(resolve => setTimeout(resolve, 300)); await fs.rm(nginxRoot, { recursive: true }); }
    for (const name of createdUnits) {
      assert.ok(services.includes(name) && name.startsWith("lms-removal-test-"));
      try { await run("systemctl", ["disable", "--now", name]); } catch { /* It may have been removed by the worker. */ }
      try { const body = await fs.readFile("/etc/systemd/system/" + name, "utf8"); assert.ok(body.includes(context.releaseRoot)); await fs.unlink("/etc/systemd/system/" + name); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (createdUnits.length) await run("systemctl", ["daemon-reload"]);
    if (createdUser) { try { await run("getent", ["passwd", user]); await run("userdel", [user]); } catch (error) { if (error.exitCode !== 2) throw error; } }
    if (createdApp) {
      try { const owner = JSON.parse(await fs.readFile(path.join(appPath, ".core-install-owner.json"), "utf8")); assert.equal(owner.clientId, clientId); assert.equal(owner.jobId, cleanupJobId); assert.equal(path.dirname(appPath), "/srv/lms-core/clients"); assert.ok(path.basename(appPath).startsWith("removal-test-")); await fs.rm(appPath, { recursive: true }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    try { const receipt = JSON.parse(await fs.readFile(path.join(result?.backupPath || path.join(backupParent, c.operationId), "receipt.json"), "utf8")); assert.equal(receipt.clientId, clientId); assert.equal(receipt.jobId, jobId); assert.equal(path.dirname(backupParent), "/srv/lms-core/backups"); await fs.rm(backupParent, { recursive: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await fs.rmdir("/srv/lms-core/publications/" + clientId); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
    if (pgRunning) await run("runuser", ["-u", "postgres", "--", path.join(pgBin, "pg_ctl"), "-D", data, "-m", "fast", "-w", "stop"]);
    if (createdPg) { assert.equal(path.dirname(pgRoot), fixtureParent); assert.equal(path.basename(pgRoot), id); await fs.rm(pgRoot, { recursive: true }); }
  }
  assert.ok(restoredBackup);
  const workerSha256 = hash(await fs.readFile(path.join(root, "infra/scripts/uninstall-lms.cjs")));
  const dependencies = {};
  for (const file of ["uninstall-lms.cjs", "publish-lms-ip.cjs", "runtime-process.cjs"]) dependencies[file] = hash(await fs.readFile(path.join(root, "infra/scripts", file)));
  const receipt = { version: 1, checkedAt: new Date().toISOString(), accepted: true, clientId, workerSha256, dependencies, realSystemd: true, privatePostgresCluster: true, realDatabaseDumpAndRestore: true, originalDatabasePreserved: true, ownFilesRestored: true,
    fixtureWebOnly: true, realNextLms: false, publicNginxRemoval: true, nginxIsolatedPort: true, remoteVps: false, fixtureCleaned: true };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  const gate = path.join(root, `infra/runtime/uninstall-acceptance.${id}.tmp`);
  await fs.writeFile(gate, JSON.stringify(receipt), { flag: "wx" }); await fs.rename(gate, path.join(root, "infra/runtime/uninstall-acceptance.json"));
  if (databaseDrop) {
    const deleteReceipt = { version: 1, accepted: true, checkedAt: new Date().toISOString(), databaseDrop: true, otherDatabasePreserved: true, foreignMarkerRejected: true, retryAccepted: true, fixtureCleaned: true, workerSha256: hash(await fs.readFile(path.join(root, "infra/scripts/delete-client-database.cjs"))) };
    await fs.writeFile(path.join(output, "client-deletion.json"), JSON.stringify(deleteReceipt, null, 2));
    await fs.writeFile(path.join(root, "infra/runtime/client-deletion-acceptance.json"), JSON.stringify(deleteReceipt));
  }
  if (fullProof) {
    const dependencies = {};
    for (const file of ["complete-lms-removal.cjs", "delete-client-database.cjs", "uninstall-lms.cjs", "publish-lms-ip.cjs", "runtime-process.cjs"]) dependencies[file] = hash(await fs.readFile(path.join(root, "infra/scripts", file)));
    const gate = { ...fullProof, dependencies, checkedAt: new Date().toISOString(), fixtureCleaned: true };
    await fs.writeFile(path.join(output, "full-removal.json"), JSON.stringify(gate, null, 2));
    await fs.writeFile(path.join(root, "infra/runtime/full-removal-acceptance.json"), JSON.stringify(gate));
  }
  console.log(JSON.stringify({ output, receipt }));
}
void acceptance().catch(error => { console.error(error.message); process.exitCode = 1; });
