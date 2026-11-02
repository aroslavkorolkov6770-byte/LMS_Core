const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { checkHttpHealth, checkLocalPage, checkPostgresHealth } = require("../dist/service-health.js");
const { appendBoundedLog, createLogWriter, pruneServiceLogs } = require("../../../infra/scripts/managed-logs.cjs");

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}/api/health`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function withLogs(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lms-core-log-test-"));
  try {
    return run(root);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("lms-core-log-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("HTTP health accepts the expected application identity", async () => {
  await withServer((_req, res) => res.end(JSON.stringify({ status: "ok", service: "fixture" })), async (url) => {
    const health = await checkHttpHealth(url, "fixture");
    assert.equal(health.healthState, "healthy");
    assert.ok(Date.parse(health.checkedAt));
  });
});

test("An unrelated HTTP listener is never healthy", async () => {
  await withServer((_req, res) => res.end(JSON.stringify({ status: "ok", service: "other" })), async (url) => {
    assert.equal((await checkHttpHealth(url, "fixture")).healthState, "unhealthy");
  });
});

test("page readiness checks actual HTML, not only an available health route", async () => {
  await withServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><h1>Core fixture</h1>"); }, async (url) => {
    assert.equal((await checkLocalPage(url)).healthState, "healthy");
  });
  for (const [status, type, body] of [[500, "text/html", "Failed"], [200, "application/json", "{}"], [200, "text/html", ""]]) {
    await withServer((_req, res) => { res.writeHead(status, { "content-type": type }); res.end(body); }, async (url) => assert.equal((await checkLocalPage(url)).healthState, "unhealthy"));
  }
  assert.equal((await checkLocalPage("https://external.invalid/")).healthState, "unhealthy");
});

test("page readiness bounds both body size and cold-start waiting", async () => {
  await withServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("x".repeat(4 * 1024 * 1024 + 1)); }, async (url) => assert.equal((await checkLocalPage(url)).healthState, "unhealthy"));
  await withServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.write("<html>"); }, async (url) => assert.equal((await checkLocalPage(url, 100)).healthState, "unhealthy"));
});

test("Malformed, failed, and redirected health responses are rejected", async () => {
  for (const status of [200, 503, 302]) {
    await withServer((_req, res) => { res.writeHead(status); res.end("not-json"); }, async (url) => {
      assert.equal((await checkHttpHealth(url, "fixture")).healthState, "unhealthy");
    });
  }
});

test("The deadline covers a server that does not finish the response", async () => {
  await withServer((_req, res) => res.write("{"), async (url) => {
    const started = Date.now();
    const health = await checkHttpHealth(url, "fixture", 100);
    assert.equal(health.healthState, "unhealthy");
    assert.ok(Date.now() - started < 1500);
  });
});

test("Oversized health responses are bounded", async () => {
  await withServer((_req, res) => res.end("x".repeat(17000)), async (url) => {
    assert.equal((await checkHttpHealth(url, "fixture")).healthState, "unhealthy");
  });
});

test("PostgreSQL health uses a real read-only statement and secret environment", async () => {
  let called = false;
  const health = await checkPostgresHealth("fixture-psql", "postgresql://fixture:fixture-password@127.0.0.1:55432/fixture_db", 55432,
    async (_file, args, options) => {
      called = true;
      assert.equal(args.includes("SELECT 1"), true);
      assert.equal(args.includes("fixture-password"), false);
      assert.equal(options.env.PGPASSWORD, "fixture-password");
      assert.equal(options.env.PGDATABASE, "fixture_db");
      assert.equal(options.env.PGCONNECT_TIMEOUT, "2");
      assert.ok(options.timeout <= 4000);
      return { stdout: "1\n" };
    });
  assert.equal(called, true);
  assert.equal(health.healthState, "healthy");
  assert.equal(JSON.stringify(health).includes("fixture-password"), false);
});

test("Local health refuses remote or mismatched database settings", async () => {
  for (const url of ["postgresql://fixture@remote.invalid:55432/db", "postgresql://fixture@127.0.0.1:5432/db", "invalid"]) {
    let called = false;
    const health = await checkPostgresHealth("fixture-psql", url, 55432, async () => { called = true; return { stdout: "1" }; });
    assert.equal(called, false);
    assert.equal(health.healthState, "unhealthy");
  }
});

test("Database failures do not expose connection credentials", async () => {
  const health = await checkPostgresHealth("fixture-psql", "postgresql://fixture:fixture-password@127.0.0.1:55432/db", 55432,
    async () => { throw new Error("connection failed: fixture-password"); });
  assert.equal(health.healthState, "unhealthy");
  assert.equal(JSON.stringify(health).includes("fixture-password"), false);
});

test("Bounded logs keep at most two archives and do not grow indefinitely", () => {
  withLogs((root) => {
    const file = path.join(root, "fixture.log");
    for (let index = 0; index < 10; index++) appendBoundedLog(root, file, "x".repeat(50), 64, 2);
    assert.equal(fs.readdirSync(root).length, 3);
    for (const name of fs.readdirSync(root)) assert.ok(fs.statSync(path.join(root, name)).size <= 64);
    appendBoundedLog(root, file, "z".repeat(1000), 64, 2);
    assert.equal(fs.statSync(file).size, 64);
  });
});

test("Log writers reject paths outside their exact log directory", () => {
  withLogs((root) => {
    assert.throws(() => createLogWriter(root, path.join(root, "..", "outside.log")), /outside/);
  });
});

test("Session retention protects active and unrelated log files", () => {
  withLogs((root) => {
    const protectedFile = path.join(root, "fixture-20261020-120000-aaaaaaaa.out.log");
    const latest = path.join(root, "fixture-20261028-120000-bbbbbbbb.out.log");
    const old = path.join(root, "fixture-20261021-120000-cccccccc.out.log");
    for (const file of [protectedFile, latest, old]) fs.writeFileSync(file, "fixture");
    fs.utimesSync(latest, new Date(), new Date(Date.now() + 1000));
    fs.writeFileSync(path.join(root, "unrelated.log"), "keep");
    pruneServiceLogs(root, "fixture", [protectedFile], 2);
    assert.equal(fs.existsSync(protectedFile), true);
    assert.equal(fs.existsSync(latest), true);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(path.join(root, "unrelated.log")), true);
  });
});
