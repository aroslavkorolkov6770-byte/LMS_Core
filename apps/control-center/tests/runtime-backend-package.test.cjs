const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { randomBytes, createHash } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { root } = require("./runtime-test-helper.cjs");
const { testDatabase, fixtureClient } = require("./fresh-install-test-helper.cjs");
const { buildRuntimeBackend } = require("../../../infra/scripts/build-runtime-backend.cjs");
const run = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const selected = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}

test("portable runtime archive initializes and serves real SQL outside the monorepo without node_modules", { timeout: 120000 }, async (t) => {
  const artifact = await buildRuntimeBackend();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "core-portable-runtime-"));
  let close;
  t.after(async () => {
    if (close) await close();
    const base = path.resolve(root, "infra/runtime/runtime-backend-packages");
    const directory = path.dirname(artifact.directory);
    assert.equal(path.dirname(directory), base);
    assert.match(path.basename(directory), /^[a-f0-9-]{36}$/);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("core-portable-runtime-"));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const { sql, databaseUrl } = await testDatabase(t, "bundle");
  assert.equal(artifact.containsBackend, true);
  assert.equal(artifact.containsLms, false);
  assert.equal(artifact.controlPlaneIncluded, false);
  assert.equal(artifact.deployed, false);
  assert.equal(hash(await fs.readFile(artifact.archivePath)), artifact.sha256);
  const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
  await run(tar, ["-xf", artifact.archivePath, "-C", temporary], { windowsHide: true });
  for (const file of artifact.files) assert.equal(hash(await fs.readFile(path.join(temporary, file.name))), file.sha256);
  assert.equal((await fs.readdir(temporary)).some((name) => ["node_modules", ".env", "src"].includes(name)), false);
  const pkg = JSON.parse(await fs.readFile(path.join(temporary, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  const client = fixtureClient();
  const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: databaseUrl, LMS_RUNTIME_CLIENT_CONFIG: JSON.stringify(client),
    LMS_RUNTIME_CLIENT_ID: client.id, LMS_RUNTIME_SERVICE_TOKEN: randomBytes(32).toString("base64url"), LMS_RUNTIME_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    LMS_RUNTIME_BOOTSTRAP_ENABLED: "true", LMS_RUNTIME_LISTEN_HOST: "127.0.0.1", LMS_RUNTIME_PORT: String(await port()) };
  delete env.NODE_PATH; delete env.NODE_OPTIONS;
  const initialize = async () => JSON.parse((await run(process.execPath, [path.join(temporary, "runtime-init.cjs")], { cwd: temporary, env, windowsHide: true, timeout: 30000 })).stdout);
  await assert.rejects(run(process.execPath, [path.join(temporary, "runtime-init.cjs")], { cwd: temporary, env: { ...env, LMS_RUNTIME_CLIENT_ID: "mismatch" }, windowsHide: true, timeout: 30000 }),
    (error) => error.code === 1 && JSON.parse(error.stderr).error === "INSTALLATION_CLIENT_MISMATCH");
  assert.equal((await initialize()).reused, false);
  assert.equal((await initialize()).reused, true);
  const origin = `http://127.0.0.1:${env.LMS_RUNTIME_PORT}`;
  const call = async (action, body) => {
    const response = await fetch(`${origin}/api/${action}`, { method: body === undefined ? "GET" : action === "lms-runtime/v1/write" ? "PUT" : "POST",
      headers: { Authorization: `Bearer ${env.LMS_RUNTIME_SERVICE_TOKEN}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const start = async () => {
    const child = spawn(process.execPath, [path.join(temporary, "runtime-api.cjs")], { cwd: temporary, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume(); child.stderr.resume();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    close = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Portable runtime exited before readiness");
      try { if ((await call("lms-runtime/v1/health")).status === 200) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Portable runtime readiness timed out");
  };
  try {
    await start();
    assert.equal((await call("deploy-panel/clients")).status, 404);
    const bootstrap = { clientAdminLogin: "fixture.admin", clientAdminName: "Fixture", clientAdminPassword: randomBytes(24).toString("base64url"),
      systemAdminLogin: "fixture.system", systemAdminPassword: randomBytes(24).toString("base64url") };
    assert.equal((await call("lms-runtime/v1/bootstrap", bootstrap)).status, 201);
    assert.equal((await call("lms-runtime/v1/write", { key: "portable_fixture", data: { text: "persisted across process restart" }, expectedRevision: 0 })).status, 200);
    await close(); close = null;
    env.LMS_RUNTIME_BOOTSTRAP_ENABLED = "false";
    await start();
    const read = await call("lms-runtime/v1/read", { keys: ["portable_fixture", "core_lms_users_v1"] });
    assert.equal(read.status, 201);
    assert.equal(read.body.entries[0].data.text, "persisted across process restart");
    assert.equal(read.body.entries[1].data.length, 2);
    assert.equal((await call("lms-runtime/v1/bootstrap", bootstrap)).status, 403);
    assert.equal((await sql`SELECT count(*)::int AS count FROM core_runtime_installation`)[0].count, 1);
  } finally { if (close) { await close(); close = null; } }
});
