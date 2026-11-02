const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const worker = require("../../../infra/scripts/uninstall-lms.cjs");
const publication = require("../../../infra/scripts/publish-lms-ip.cjs");
const vault = require("../../../infra/scripts/runtime-process.cjs");

async function fixture(t, https = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-removal-fixture-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-removal-fixture-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const c = { clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), operationId: crypto.randomUUID(), host: "198.51.100.25", appPath: "/srv/lms-core/clients/removal-fixture", webPort: 3000 };
  const disk = name => path.join(root, name), app = disk(c.appPath), releaseRoot = `${c.appPath}/releases/${c.releaseId}`;
  const context = { clientId: c.clientId, releaseId: c.releaseId, releaseRoot, webPort: c.webPort, apiPort: 4101 };
  const user = "lms-" + crypto.createHash("sha256").update(c.clientId).digest("hex").slice(0, 20);
  const services = ["api", "web"].map(role => `lms-removal-fixture-${role}.service`);
  for (const name of [app + "/shared", disk(releaseRoot), disk("/etc/systemd/system"), disk("/etc/nginx/conf.d")]) await fs.mkdir(name, { recursive: true });
  await fs.writeFile(path.join(app, ".core-install-owner.json"), JSON.stringify({ clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, state: "installed", services }));
  await fs.writeFile(path.join(app, "shared/runtime-context.json"), JSON.stringify(context));
  const key = crypto.randomBytes(32), suffix = c.clientId.replaceAll("-", "");
  const databaseUrl = `postgresql://lms_role_${suffix}:fixture-private-password@127.0.0.1:5432/lms_${suffix}`;
  await fs.writeFile(path.join(app, "shared/runtime-vault.key"), key);
  await fs.writeFile(path.join(app, "shared/runtime-vault.json"), JSON.stringify(vault.sealSecrets({ databaseUrl }, key, c.clientId)));
  await fs.writeFile(path.join(app, "shared/customer-upload.bin"), "client file must survive");
  await fs.symlink(disk(releaseRoot), path.join(app, "current"), "junction");
  const states = new Map(), calls = [], failure = { dump: false, restoreList: false, nginx: false };
  for (const [index, name] of services.entries()) {
    await fs.writeFile(disk("/etc/systemd/system/" + name), worker.expectedService(context, user, "/usr/bin/node", index === 0 ? "api" : "web"));
    states.set(name, { active: true, enabled: true });
  }
  const nginx = disk(`/etc/nginx/conf.d/lms-core-${c.clientId}.conf`);
  await fs.writeFile(nginx, https ? publication.nginxHttpsConfiguration(c) : publication.nginxConfiguration(c));
  if (https) for (const [name, body] of publication.renewalConfiguration(c).files.filter(([name]) => name.startsWith("/etc/systemd/system"))) {
    await fs.writeFile(disk(name), body); states.set(path.basename(name), { active: name.endsWith(".timer"), enabled: name.endsWith(".timer") });
  }
  await fs.writeFile(disk("/etc/nginx/conf.d/other-client.conf"), "do not touch other site");
  const run = async (file, args, settings = {}) => {
    calls.push([file, ...args]);
    assert.ok(!JSON.stringify(args).includes("fixture-private-password"));
    if (file === "pg_dump") {
      if (args[0] === "--version") return "pg_dump (PostgreSQL) 18.0";
      assert.equal(settings.env.PGPASSWORD, "fixture-private-password");
      if (failure.dump) throw Object.assign(Error("mock failure"), { code: "REMOVAL_COMMAND_FAILED" });
      await fs.writeFile(args[args.indexOf("--file") + 1], "PGDMP fixture not a real database dump"); return "";
    }
    if (file === "pg_restore") return args[0] === "--version" ? "pg_restore 18.0" : failure.restoreList ? "bad file" : "TABLE DATA public clients";
    if (file === "psql") { assert.equal(settings.env.PGPASSWORD, "fixture-private-password"); return "65536|180000\n"; }
    if (file === "nginx") { if (failure.nginx) { failure.nginx = false; throw Error("mock nginx failure"); } return ""; }
    if (file === "systemctl") {
      if (args[0] === "daemon-reload" || args[0] === "reload" && args[1] === "nginx") return "";
      const state = states.get(args[1]); assert.ok(state, `must never signal an unrelated service: ${args[1]}`);
      if (args[0] === "is-active") return state.active ? "active\n" : "inactive\n";
      if (args[0] === "is-enabled") return state.enabled ? "enabled\n" : "disabled\n";
      if (args[0] === "stop") state.active = false;
      else if (args[0] === "start") state.active = true;
      else if (args[0] === "disable") state.enabled = false;
      else if (args[0] === "enable") state.enabled = true;
      else assert.fail("Unexpected service command"); return "";
    }
    assert.fail("Unexpected executable " + file);
  };
  return { root, c, disk, app, services, nginx, calls, states, failure, options: { root, run, fixture: true, publication, unseal: vault.openSecrets, agreement: true, minimumFreeBytes: 0 } };
}

test("removal input never accepts arbitrary root, traversal or a different service port", () => {
  for (const appPath of ["/", "/etc", "/srv/lms-core/clients", "/srv/lms-core/clients/../other", "/var/www/pilot"]) assert.throws(() => worker.validateRemoval({ clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), operationId: crypto.randomUUID(), host: "127.0.0.1", webPort: 3000, appPath }));
});
test("read-only removal inspection makes no dump, stops nothing, and never returns secrets", async t => {
  const f = await fixture(t), result = await worker.inspectRemoval(f.c, f.options);
  assert.equal(result.phase, "checked"); assert.equal(result.preserveData, true);
  assert.ok(!f.calls.some(call => ["stop", "disable", "start", "enable"].includes(call[1])));
  assert.equal(f.calls.filter(call => call[0] === "pg_dump").length, 1);
  assert.ok(!JSON.stringify(result).includes("fixture-private-password"));
});
test("uninstall archives the selected app, keeps files/database/keys, removes only its units/proxy", async t => {
  const f = await fixture(t, true), result = await worker.uninstallLms(f.c, f.options);
  assert.equal(result.phase, "uninstalled", JSON.stringify(result)); assert.equal(result.databaseDeleted, false);
  assert.match(result.databaseDumpSha256, /^[a-f0-9]{64}$/);
  const backup = f.disk(result.backupPath);
  assert.equal(await fs.readFile(path.join(backup, "application/shared/customer-upload.bin"), "utf8"), "client file must survive");
  assert.equal((await fs.stat(path.join(backup, "application/shared/runtime-vault.key"))).size, 32);
  assert.equal(await fs.readFile(f.disk("/etc/nginx/conf.d/other-client.conf"), "utf8"), "do not touch other site");
  await assert.rejects(fs.lstat(f.app)); await assert.rejects(fs.lstat(f.nginx));
  for (const name of f.services) assert.equal(f.states.get(name).active, false);
  assert.ok(!JSON.stringify(result).includes("fixture-private-password"));
  assert.ok(!f.calls.some(call => ["dropdb", "userdel", "apt", "ufw", "rm", "shutdown"].includes(call[0])));
  assert.ok(!JSON.stringify(f.calls).includes("postgresql.service"));
});
test("missing agreement and foreign owner refuse before stopping anything", async t => {
  const f = await fixture(t);
  await assert.rejects(worker.uninstallLms(f.c, { ...f.options, agreement: false }), /REMOVAL_CONFIRMATION_REQUIRED/);
  await assert.rejects(worker.uninstallLms({ ...f.c, clientId: crypto.randomUUID() }, f.options), /REMOVAL_OWNER_MISMATCH/);
  assert.ok(!f.calls.some(call => call[1] === "stop"));
});
test("modified service or nginx configuration is never removed", async t => {
  const f = await fixture(t);
  await fs.appendFile(f.nginx, "# independent edit\n");
  await assert.rejects(worker.uninstallLms(f.c, f.options), /REMOVAL_NGINX_CHANGED/);
  assert.ok(!f.calls.some(call => call[1] === "stop"));
  await fs.writeFile(f.nginx, publication.nginxConfiguration(f.c));
  await fs.appendFile(f.disk("/etc/systemd/system/" + f.services[0]), "# independent edit\n");
  await assert.rejects(worker.uninstallLms(f.c, f.options), /REMOVAL_SERVICE_MISMATCH/);
});
test("failed or invalid database backup restores previous services and keeps the original application", async t => {
  for (const kind of ["dump", "restoreList"]) {
    const f = await fixture(t); f.failure[kind] = true;
    const result = await worker.uninstallLms(f.c, f.options);
    assert.equal(result.phase, "failed"); assert.equal(result.rollbackRestored, true);
    assert.ok((await fs.stat(f.app)).isDirectory());
    assert.equal(await fs.readFile(f.nginx, "utf8"), publication.nginxConfiguration(f.c));
    for (const name of f.services) assert.equal(f.states.get(name).active, true);
  }
});
test("a preexisting operation lock blocks a second uninstall without disturbing the first", async t => {
  const f = await fixture(t), lock = path.join(f.app, "shared/ai-configuration.lock");
  await fs.writeFile(lock, "other operation");
  await assert.rejects(worker.uninstallLms(f.c, f.options), /REMOVAL_NOT_STARTED/);
  assert.equal(await fs.readFile(lock, "utf8"), "other operation");
  assert.ok(!f.calls.some(call => call[1] === "stop"));
});
test("insufficient backup disk refuses before stopping any process", async t => {
  const f = await fixture(t);
  await assert.rejects(worker.uninstallLms(f.c, { ...f.options, minimumFreeBytes: Number.MAX_SAFE_INTEGER }), /REMOVAL_BACKUP_DISK_REQUIRED/);
  assert.ok(!f.calls.some(call => call[1] === "stop"));
});
test("database vault for another database refuses without dump or service changes", async t => {
  const f = await fixture(t), key = await fs.readFile(path.join(f.app, "shared/runtime-vault.key"));
  await fs.writeFile(path.join(f.app, "shared/runtime-vault.json"), JSON.stringify(vault.sealSecrets({ databaseUrl: "postgresql://postgres:fixture@localhost/postgres" }, key, f.c.clientId)));
  await assert.rejects(worker.uninstallLms(f.c, f.options), /REMOVAL_DATABASE_MISMATCH/);
  assert.ok(!f.calls.some(call => call[0] === "pg_dump" || call[1] === "stop"));
});
test("nginx validation failure after archiving configuration restores files and the previous services", async t => {
  const f = await fixture(t, true), original = f.options.run;
  let validations = 0;
  f.options.run = async (file, args, settings) => { if (file === "nginx" && args[0] === "-t" && ++validations === 2) throw Object.assign(Error("fixture error"), { code: "REMOVAL_COMMAND_FAILED" }); return original(file, args, settings); };
  const result = await worker.uninstallLms(f.c, f.options);
  assert.equal(result.phase, "failed"); assert.equal(result.rollbackRestored, true);
  assert.equal(await fs.readFile(f.nginx, "utf8"), publication.nginxHttpsConfiguration(f.c));
  assert.ok((await fs.stat(f.app)).isDirectory());
  for (const name of f.services) assert.equal(f.states.get(name).active, true);
});
test("concurrent configuration edit while backing up is preserved rather than deleted", async t => {
  const f = await fixture(t), original = f.options.run;
  f.options.run = async (file, args, settings) => { const value = await original(file, args, settings); if (file === "pg_dump" && args[0] !== "--version") await fs.appendFile(f.nginx, "# independent change during backup\n"); return value; };
  const result = await worker.uninstallLms(f.c, f.options);
  assert.equal(result.phase, "failed"); assert.equal(result.rollbackRestored, true);
  assert.ok((await fs.readFile(f.nginx, "utf8")).endsWith("# independent change during backup\n"));
  for (const name of f.services) assert.equal(f.states.get(name).active, true);
});
test("independent unit appearing during rollback is not overwritten or started", async t => {
  const f = await fixture(t), original = f.options.run;
  let validations = 0;
  const unitFile = f.disk("/etc/systemd/system/" + f.services[0]);
  f.options.run = async (file, args, settings) => {
    if (file === "nginx" && args[0] === "-t" && ++validations === 2) { await fs.writeFile(unitFile, "independent new service"); throw Error("fixture error"); }
    return original(file, args, settings);
  };
  const result = await worker.uninstallLms(f.c, f.options);
  assert.equal(result.phase, "needs_attention"); assert.equal(result.rollbackRestored, false);
  assert.equal(await fs.readFile(unitFile, "utf8"), "independent new service");
  assert.ok(!f.calls.some(call => call[1] === "start"));
});
