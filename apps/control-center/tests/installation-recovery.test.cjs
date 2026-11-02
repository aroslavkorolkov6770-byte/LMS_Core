const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const worker = require("../../../infra/scripts/recover-failed-installation.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-recovery-"));
  t.after(async () => { assert.ok(path.basename(root).startsWith("core-recovery-")); await fs.rm(root, { recursive: true }); });
  const input = { clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), appPath: "/srv/lms-core/clients/recovery-fixture" };
  const c = worker.validate(input), disk = p => path.join(root, p), calls = [];
  await fs.mkdir(disk(input.appPath), { recursive: true }); await fs.mkdir(disk(`/srv/lms-core/jobs/${input.jobId}`), { recursive: true });
  await fs.writeFile(disk(input.appPath + "/.core-install-owner.json"), JSON.stringify({ ...input, state: "installing" }));
  await fs.writeFile(disk(`/srv/lms-core/jobs/${input.jobId}/status.json`), JSON.stringify({ id: input.jobId, clientId: input.clientId, releaseId: input.releaseId, phase: "needs_attention", failedStep: "initialize", errorCode: "DATABASE_PROVISION_UNCONFIRMED" }));
  const options = { fixture: true, root, agreement: true, inspectDatabase: async () => "0|0", run: async (file, args) => {
    calls.push([file, args]);
    if (file === "getent" && args[0] === "passwd") return `${c.user}:x:901:901::${input.appPath}/shared/home:/usr/sbin/nologin\n`;
    if (file === "getent") return `${c.user}:x:901:\n`;
    if (file === "id") return "901\n";
    return "";
  } };
  return { input, c, root, disk, calls, options };
}
test("failed own job with absent database and role can be archived and retried", async t => {
  const f = await fixture(t); assert.equal((await worker.inspectRecovery(f.input, f.options)).phase, "retry_available");
  const result = await worker.recoverFailedInstallation(f.input, f.options); assert.equal(result.phase, "retry_available");
  await assert.rejects(fs.stat(f.disk(f.input.appPath)));
  assert.ok(await fs.stat(f.disk(f.c.archive + "/application/.core-install-owner.json")));
  const status = JSON.parse(await fs.readFile(f.disk(`/srv/lms-core/jobs/${f.input.jobId}/status.json`)));
  assert.equal(status.phase, "failed"); assert.equal(status.errorCode, "INSTALLATION_RETRY_READY");
  assert.deepEqual(f.calls.filter(([file]) => file === "userdel").map(([, args]) => args), [[f.c.user]]);
  assert.equal(f.calls.some(([file]) => /drop|rm/.test(file)), false);
});
test("an existing database/role is never deleted or adopted by reservation recovery", async t => {
  const f = await fixture(t);
  for (const value of ["1|0", "0|1", "1|1"]) await assert.rejects(worker.recoverFailedInstallation(f.input, { ...f.options, inspectDatabase: async () => value }), /DATABASE_EXISTS/);
  assert.equal(f.calls.some(([file]) => file === "userdel"), false); assert.ok(await fs.stat(f.disk(f.input.appPath)));
});
test("confirmation, owner, stage, active services and installed context guard recovery", async t => {
  const f = await fixture(t);
  await assert.rejects(worker.recoverFailedInstallation(f.input, { ...f.options, agreement: false }), /CONFIRMATION/);
  const owner = f.disk(f.input.appPath + "/.core-install-owner.json");
  await fs.writeFile(owner, JSON.stringify({ ...f.input, jobId: crypto.randomUUID(), state: "installing" }));
  await assert.rejects(worker.inspectRecovery(f.input, f.options), /OWNER/);
  await fs.writeFile(owner, JSON.stringify({ ...f.input, state: "installing" }));
  await fs.mkdir(f.disk(f.input.appPath + "/shared")); await fs.writeFile(f.disk(f.input.appPath + "/shared/runtime-context.json"), "{}");
  await assert.rejects(worker.inspectRecovery(f.input, f.options), /RESOURCE_STILL_PRESENT/);
});
test("shared or busy Linux accounts cannot be removed", async t => {
  const f = await fixture(t), run = f.options.run;
  await assert.rejects(worker.inspectRecovery(f.input, { ...f.options, run: (file, args) => file === "id" ? "901 902" : run(file, args) }), /FOREIGN_GROUPS/);
  await assert.rejects(worker.inspectRecovery(f.input, { ...f.options, run: (file, args) => file === "ps" ? "1234" : run(file, args) }), /ACCOUNT_BUSY/);
});
