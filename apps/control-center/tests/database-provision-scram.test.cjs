const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { randomBytes, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { dbRequire, root } = require("./runtime-test-helper.cjs");
const { fixtureClient } = require("./fresh-install-test-helper.cjs");
const { db } = require("./database-provision-test-helper.cjs");
const { buildRuntimeBackend } = require("../../../infra/scripts/build-runtime-backend.cjs");

async function run(file, args, { input, env, cwd, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    // Never attach input/env/argv to errors: those may contain private credentials.
    const timer = setTimeout(() => child.kill(), timeout);
    child.once("error", () => { clearTimeout(timer); reject(Error("Fixture process could not start")); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value;
}

test("portable provision/init commands work with real SCRAM authentication in an isolated PostgreSQL cluster", { timeout: 180000 }, async (t) => {
  const bin = process.env.CORE_TEST_PG_BIN || "C:\\Program Files\\PostgreSQL\\18\\bin";
  const suffix = process.platform === "win32" ? ".exe" : "";
  const binary = (name) => path.join(bin, name + suffix);
  await fs.stat(binary("initdb")); await fs.stat(binary("pg_ctl"));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "core-scram-fixture-"));
  const data = path.join(temporary, "data"), backend = path.join(temporary, "backend");
  let started = false, artifact;
  const pools = [];
  t.after(async () => {
    for (const pool of pools) await pool.end({ timeout: 5 });
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("core-scram-fixture-"));
    if (started) {
      const stopped = await run(binary("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
      assert.equal(stopped.code, 0, "Refusing cleanup because owned PostgreSQL did not stop");
    }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (artifact) {
      const directory = path.dirname(artifact.directory);
      assert.equal(path.dirname(directory), path.join(root, "infra/runtime/runtime-backend-packages"));
      assert.match(path.basename(directory), /^[a-f0-9-]{36}$/);
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  if (process.platform === "win32") {
    const identity = await run(path.join(process.env.SystemRoot, "System32/whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/);
    assert.ok(identity.code === 0 && sid, "Cannot verify fixture directory owner");
    const acl = await run(path.join(process.env.SystemRoot, "System32/icacls.exe"), [temporary, "/inheritance:r", "/grant:r", `*${sid[0]}:(OI)(CI)F`]);
    assert.equal(acl.code, 0, "Cannot protect temporary fixture password");
  }
  const adminPassword = randomBytes(32).toString("base64url");
  // initdb requires a file, not stdin. This random fixture-only secret exists in a private directory until initdb exits.
  const passwordFile = path.join(temporary, "fixture-init-password");
  await fs.writeFile(passwordFile, `${adminPassword}\n`, { mode: 0o600, flag: "wx" });
  let initialized;
  try { initialized = await run(binary("initdb"), ["-D", data, "--username=core_fixture_admin", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C"]); }
  finally { await fs.unlink(passwordFile); }
  assert.equal(initialized.code, 0, `Isolated initdb failed: ${initialized.stderr.replaceAll(adminPassword, "[secret]").slice(0, 2000)}`);
  const port = await freePort();
  const start = await run(binary("pg_ctl"), ["-D", data, "-l", path.join(temporary, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"]);
  assert.equal(start.code, 0, "Isolated PostgreSQL did not start"); started = true;
  const maintenance = new URL(`postgresql://core_fixture_admin@127.0.0.1:${port}/postgres`); maintenance.password = adminPassword;
  const input = { maintenanceUrl: maintenance.href, clientId: randomUUID(), jobId: randomUUID(), password: randomBytes(32).toString("base64url") };
  const postgres = dbRequire("postgres");
  const connect = (url) => { const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} }); pools.push(sql); return sql; };
  const admin = connect(maintenance.href);
  const methods = await admin`SELECT auth_method FROM pg_hba_file_rules WHERE type LIKE 'host%' AND error IS NULL`;
  assert.ok(methods.length > 0 && methods.every((row) => row.auth_method === "scram-sha-256"));
  artifact = await buildRuntimeBackend(); await fs.mkdir(backend);
  const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
  assert.equal((await run(tar, ["-xf", artifact.archivePath, "-C", backend])).code, 0);
  const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
  const provision = () => run(process.execPath, [path.join(backend, "runtime-provision.cjs")], { input: JSON.stringify(input), cwd: temporary, env });
  const first = await provision();
  assert.equal(first.code, 0, first.stderr); assert.equal(JSON.parse(first.stdout).reused, false);
  assert.equal(first.stdout.includes(input.password) || first.stderr.includes(input.password), false);
  assert.equal(first.stdout.includes(adminPassword) || first.stderr.includes(adminPassword), false);
  const databaseUrl = db.clientDatabaseUrl(maintenance.href, input.clientId, input.password);
  assert.equal((await db.assertRestrictedDatabaseRole(databaseUrl, input.clientId)).restricted, true);
  const wrong = new URL(databaseUrl); wrong.password = randomBytes(32).toString("base64url");
  await assert.rejects(connect(wrong.href).unsafe("SELECT 1"), (error) => error.code === "28P01");
  const client = { ...fixtureClient(), id: input.clientId };
  const initEnv = { ...env, DATABASE_URL: databaseUrl, LMS_RUNTIME_CLIENT_ID: input.clientId, LMS_RUNTIME_CLIENT_CONFIG: JSON.stringify(client), LMS_RUNTIME_REQUIRE_RESTRICTED_ROLE: "true" };
  const init = () => run(process.execPath, [path.join(backend, "runtime-init.cjs")], { cwd: temporary, env: initEnv });
  const installed = await init(); assert.equal(installed.code, 0, installed.stderr); assert.equal(JSON.parse(installed.stdout).reused, false);
  assert.equal(JSON.parse((await init()).stdout).reused, true);
  assert.equal(JSON.parse((await provision()).stdout).reused, true);
  const adminOnTenant = new URL(maintenance.href); adminOnTenant.pathname = new URL(databaseUrl).pathname;
  const refused = await run(process.execPath, [path.join(backend, "runtime-init.cjs")], { cwd: temporary, env: { ...initEnv, DATABASE_URL: adminOnTenant.href } });
  assert.equal(refused.code, 1); assert.equal(JSON.parse(refused.stderr).error, "DATABASE_ROLE_NOT_RESTRICTED");
  const sql = connect(databaseUrl);
  assert.equal((await sql`SELECT count(*)::int AS count FROM users`)[0].count, 0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM courses`)[0].count, 0);
});
