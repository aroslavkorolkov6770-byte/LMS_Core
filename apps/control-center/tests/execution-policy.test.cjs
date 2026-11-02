const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { ExecutionPolicy } = require("../dist/execution-policy.js");
test("execution policy defaults to local, persists explicit mode and fails closed on damaged settings", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-policy-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-policy-")); await fs.rm(root, { recursive: true, force: true }); });
  const policy = new ExecutionPolicy(root);
  assert.equal(await policy.mode(), "local"); assert.equal(await policy.allowed({ host: "127.0.0.1" }), true); assert.equal(await policy.allowed({ host: "server.invalid" }), false);
  await policy.set("remote"); assert.equal(await new ExecutionPolicy(root).allowed({ host: "server.invalid" }), true);
  await policy.set("local"); await assert.rejects(policy.set("unexpected"));
  await fs.writeFile(path.join(root, "infra/runtime/execution-policy.json"), "bad json"); assert.equal(await policy.mode(), "local");
});
