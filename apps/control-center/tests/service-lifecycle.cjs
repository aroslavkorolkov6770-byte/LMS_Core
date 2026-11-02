const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { runJsonCommand } = require("../dist/command-json.js");

if (process.platform !== "win32") {
  console.log("Launcher integration test requires Windows.");
  process.exit(0);
}

const sourceRoot = path.resolve(__dirname, "../../..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lms-core-launcher-test-"));
let externalServer;
let managedMayExist = false;

function writeFixture(relativePath, content) {
  const target = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

async function runAction(action) {
  return runJsonCommand("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(fixtureRoot, "infra/scripts/control-dev-service.ps1"),
    "-Action", action, "-ServiceId", "fixture"
  ], fixtureRoot, 80000, (value) => value && value.id === "fixture");
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startExternalServer(port) {
  const child = spawn(process.execPath, ["-e", `require('node:net').createServer().listen(${port}, '127.0.0.1', () => console.log('ready'))`], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`External fixture exited: ${code}`)));
  });
  return child;
}

async function main() {
  const port = await findFreePort();
  const sourceScript = path.join(sourceRoot, "infra/scripts/control-dev-service.ps1");
  writeFixture("infra/scripts/control-dev-service.ps1", fs.readFileSync(sourceScript));
  writeFixture("infra/scripts/spawn-managed-service.cjs", fs.readFileSync(path.join(sourceRoot, "infra/scripts/spawn-managed-service.cjs")));
  writeFixture("infra/scripts/managed-logs.cjs", fs.readFileSync(path.join(sourceRoot, "infra/scripts/managed-logs.cjs")));
  writeFixture("package.json", JSON.stringify({ private: true, packageManager: "pnpm@9.12.3" }));
  writeFixture("apps/fake/package.json", JSON.stringify({ private: true, scripts: { dev: "node server.cjs" } }));
  writeFixture("apps/fake/server.cjs", "require('node:net').createServer().listen(Number(process.env.FIXTURE_PORT), '127.0.0.1');\n");
  writeFixture("apps/fake/.next/preserve.txt", "keep build\n");
  writeFixture("infra/runtime/logs/fixture.out.log", "keep log\n");
  writeFixture("apps/control-center/config/launcher-config.json", JSON.stringify({
    environment: { FIXTURE_PORT: String(port) },
    services: [{ id: "fixture", label: "Fixture", kind: "pnpm", command: "pnpm --dir apps/fake dev", port, url: "" }]
  }));

  externalServer = await startExternalServer(port);
  assert.equal((await runAction("Start")).ok, false, "An occupied port must not be adopted.");
  assert.equal((await runAction("Stop")).ok, false, "An unrelated process must not be stopped.");
  assert.equal(externalServer.exitCode, null);
  externalServer.kill();
  await new Promise((resolve) => externalServer.once("exit", resolve));
  externalServer = undefined;

  managedMayExist = true;
  const started = await runAction("Start");
  assert.equal(started.ok, true, started.message);
  assert.equal(started.running, true);
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "apps/fake/.next/preserve.txt"), "utf8"), "keep build\n");
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "infra/runtime/logs/fixture.out.log"), "utf8"), "keep log\n");
  assert.ok(fs.existsSync(started.logFile), "A separate runtime log must be created.");
  assert.equal((await runAction("Start")).ok, true, "Starting an owned service twice must be safe.");
  const stopped = await runAction("Stop");
  assert.equal(stopped.ok, true, stopped.message);
  assert.equal(stopped.running, false);
  managedMayExist = false;

  externalServer = await startExternalServer(port);
  assert.equal((await runAction("Stop")).ok, false, "Stale ownership must not affect a new listener.");
  assert.equal(externalServer.exitCode, null);
  console.log("PASS: managed start/stop, duplicate start, port collision, stale PID, and preserved files.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (managedMayExist) {
    try {
      const result = await runAction("Stop");
      managedMayExist = !result.ok;
    } catch (error) { console.error("Fixture cleanup failed:", error); }
  }
  if (externalServer && externalServer.exitCode === null) {
    await new Promise((resolve) => {
      externalServer.once("exit", resolve);
      externalServer.kill();
    });
  }
  const safeFixture = path.dirname(path.resolve(fixtureRoot)) === path.resolve(os.tmpdir()) &&
    path.basename(fixtureRoot).startsWith("lms-core-launcher-test-");
  if (safeFixture && !managedMayExist) {
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) { console.error("Fixture files retained:", fixtureRoot, error.message); }
  }
});
