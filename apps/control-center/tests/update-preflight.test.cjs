const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const script = path.resolve(__dirname, "../../../infra/scripts/lms-update-preflight.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-preflight-test-"));
  t.after(async () => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("core-preflight-test-")) throw new Error("Unsafe cleanup");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const app = path.join(root, "app");
  await fs.mkdir(path.join(app, "data"), { recursive: true });
  await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ dependencies: { next: "fixture" }, scripts: { build: "must-not-run", start: "must-not-run" } }));
  await fs.writeFile(path.join(app, "package-lock.json"), "{}");
  await fs.writeFile(path.join(app, "data", "users.json"), '{"fixture":"unchanged"}');
  const inspect = async () => JSON.parse((await run(process.execPath, [script, Buffer.from(JSON.stringify({ appPath: app })).toString("base64")], { timeout: 25000, windowsHide: true })).stdout);
  return { root, app, inspect };
}

test("preflight reads a real fixture but neither changes data nor outputs env secrets", async (t) => {
  const f = await fixture(t);
  const env = "DATA_BACKEND=json\nMYSQL_PASSWORD=fixture-secret\nAI_API_KEY=fixture-secret\n";
  await fs.writeFile(path.join(f.app, ".env.production"), env);
  const result = await f.inspect();
  assert.equal(result.backend, "json");
  assert.equal(result.projectKind, "nextjs");
  assert.equal(result.packageManager, "npm");
  assert.equal(result.protectedPaths[0].files, 1);
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  assert.equal(await fs.readFile(path.join(f.app, ".env.production"), "utf8"), env);
  assert.equal(await fs.readFile(path.join(f.app, "data/users.json"), "utf8"), '{"fixture":"unchanged"}');
  assert.ok(result.warnings.some((text) => text.includes("управляющий процесс")));
});

test("Next production env precedence is respected without exposing values", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.app, ".env"), "DATA_BACKEND=json\n");
  await fs.writeFile(path.join(f.app, ".env.production.local"), "DATA_BACKEND='mysql'\nMYSQL_PASSWORD=fixture-secret\n");
  const result = await f.inspect();
  assert.equal(result.backend, "mysql");
  assert.ok(result.warnings.some((text) => text.includes("SQL backup")));
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});

test("a missing or unsupported backend is not assumed to be json", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).backend, "unknown");
  await fs.writeFile(path.join(f.app, ".env"), "DATA_BACKEND=fixture-secret\n");
  const result = await f.inspect();
  assert.equal(result.backend, "unknown");
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});

test("an explicit supported legacy config default can identify json", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.app, "app/lib/database"), { recursive: true });
  await fs.writeFile(path.join(f.app, "app/lib/database/config.ts"), "const backend = process.env.DATA_BACKEND || 'json';");
  assert.equal((await f.inspect()).backend, "json");
});

test("a malformed package cannot leak a configuration fragment through stderr", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.app, "package.json"), "{fixture-secret-broken-json");
  await assert.rejects(f.inspect(), (error) => error.stderr.trim() === "LMS_PREFLIGHT_FAILED" && !error.stdout.includes("fixture-secret"));
});
