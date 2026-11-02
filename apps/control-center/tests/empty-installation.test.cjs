const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { inspectEmptyInstallation } = require("../../../infra/scripts/inspect-empty-installation.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-empty-install-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-empty-install-")); await fs.rm(root, { recursive: true, force: true }); });
  const input = { clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), appPath: "/srv/lms-core/clients/fixture" };
  const status = { id: input.jobId, clientId: input.clientId, releaseId: input.releaseId, phase: "needs_attention", failedStep: "reserve", errorCode: "NAMESPACE_NOT_TRAVERSABLE" };
  const directory = path.join(root, "srv/lms-core/jobs", input.jobId); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "status.json"), JSON.stringify(status), { mode: 0o600 });
  const state = { database: "0|0", accounts: "root:x:0:0:root:/root:/bin/sh" }, calls = [];
  const options = { fixture: true, root, run: async (file, args) => { calls.push({ file, args }); return file === "getent" ? state.accounts : state.database; } };
  return { root, input, status, directory, state, options, calls, inspect: () => inspectEmptyInstallation(input, options) };
}
test("an exact stopped reservation with no path, account, SQL objects or services is safe to retry without deletions", async t => {
  const f = await fixture(t); assert.equal((await f.inspect()).empty, true);
  assert.deepEqual(f.calls.map(call => call.file), ["getent", "runuser"]);
  assert.ok(f.calls[1].args.at(-1).startsWith("SELECT "));
});
test("existing SQL data or service account blocks the retry", async t => {
  const f = await fixture(t); f.state.database = "1|0"; await assert.rejects(f.inspect());
  f.state.database = "0|0";
  f.state.accounts += "\nlms-" + crypto.createHash("sha256").update(f.input.clientId).digest("hex").slice(0, 20) + ":x:900:900::/:/usr/sbin/nologin";
  await assert.rejects(f.inspect());
});
test("existing client directory or foreign job identity cannot be declared empty", async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, f.input.appPath), { recursive: true }); await assert.rejects(f.inspect());
  await fs.writeFile(path.join(f.directory, "status.json"), JSON.stringify({ ...f.status, clientId: crypto.randomUUID() }));
  await assert.rejects(f.inspect());
});
