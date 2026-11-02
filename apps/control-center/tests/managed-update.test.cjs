const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { runManagedUpdate } = require("../../../infra/scripts/lms-managed-update.cjs");
const { ManagedUpdateService, resolveManagedUpdateTarget } = require("../dist/managed-update.js");
const ui = require("../renderer/deployment-workflow.js");
const uuid = () => crypto.randomUUID();
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

async function fixture(t, linked = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-managed-update-"));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("core-managed-update-")); await fs.rm(root, { recursive: true, force: true }); });
  const c = { id: uuid(), clientId: uuid(), jobId: uuid(), releaseId: uuid(), packageId: uuid(), appPath: "/srv/lms-core/clients/update-fixture", webPort: 23921, revision: "b".repeat(40), sha256: "c".repeat(64) };
  const disk = name => path.join(root, name), appRoot = disk(c.appPath), release = path.join(appRoot, "releases", c.releaseId), app = path.join(release, "lms"), shared = path.join(appRoot, "shared"), payload = path.join(root, "payload");
  await fs.mkdir(path.join(app, "app/api/core-runtime/health"), { recursive: true }); await fs.mkdir(path.join(app, ".next")); await fs.mkdir(shared); await fs.mkdir(path.join(release, "backend"));
  await fs.mkdir(path.join(payload, "lms/app/api/core-runtime/health"), { recursive: true }); await fs.mkdir(path.join(payload, "backend"));
  await fs.mkdir(disk("/etc/systemd/system"), { recursive: true });
  const user = "lms-" + sha(c.clientId).slice(0, 20), unit = "lms-update-fixture-web.service", capability = "lms-core-client-v1 postgresql-runtime";
  await fs.writeFile(path.join(appRoot, ".core-install-owner.json"), JSON.stringify({ state: "installed", clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, services: [unit] }));
  await fs.writeFile(path.join(shared, "runtime-context.json"), JSON.stringify({ clientId: c.clientId, releaseId: c.releaseId, releaseRoot: `${c.appPath}/releases/${c.releaseId}`, webPort: c.webPort }));
  await fs.symlink(release, path.join(appRoot, "current"), "junction");
  await fs.writeFile(disk(`/etc/systemd/system/${unit}`), `User=${user}\nExecStart=/usr/bin/node ${c.appPath}/releases/${c.releaseId}/backend/runtime-process.cjs ${c.appPath}/shared/runtime-context.json web\n`);
  await fs.writeFile(path.join(app, "app/api/core-runtime/health/route.ts"), capability); await fs.writeFile(path.join(payload, "lms/app/api/core-runtime/health/route.ts"), capability);
  await fs.writeFile(path.join(app, ".next/BUILD_ID"), "old-build"); await fs.writeFile(path.join(app, "interface.txt"), "old-interface"); await fs.writeFile(path.join(payload, "lms/interface.txt"), "selected-new-git");
  for (const base of [release, payload]) await fs.writeFile(path.join(base, "backend/baseline.sql"), "unchanged-schema");
  await fs.writeFile(path.join(shared, "database-sentinel"), "existing-client-data");
  const secret = "AI_API_KEY=fixture-secret-key\nAI_PROMPT_ID=fixture-prompt\nSMTP_PASS=fixture-mail-secret\n";
  if (linked) { await fs.writeFile(path.join(shared, "ai.env"), secret); await fs.symlink(path.join(shared, "ai.env"), path.join(app, ".env.production.local")); }
  else await fs.writeFile(path.join(app, ".env.production.local"), secret);
  const state = { calls: [], failBuild: false, failHealth: false };
  const options = { root, fixture: true, account: { uid: 0, gid: 0 }, attempts: 1, delayMs: 1,
    verifyPackage: async (_payload, id) => { assert.equal(id, c.packageId); return { revision: c.revision }; },
    run: async (file, args) => { assert.equal(file, "systemctl"); assert.equal(args.at(-1), unit); state.calls.push(args[0]); },
    fetch: async url => { assert.ok(url.endsWith("/api/core-runtime/health")); const current = await fs.readFile(path.join(app, ".next/BUILD_ID"), "utf8"); const ok = !(state.failHealth && current === "new-build"); return { ok, json: async () => ({ protocol: "lms-core-client-v1", status: ok ? "ok" : "unavailable", clientId: c.clientId, releaseId: c.releaseId }) }; },
    build: async stage => { assert.equal(await fs.readFile(path.join(app, "interface.txt"), "utf8"), "old-interface"); assert.equal(await fs.readFile(path.join(stage, "interface.txt"), "utf8"), "selected-new-git"); await assert.rejects(fs.stat(path.join(stage, ".env.production.local")), { code: "ENOENT" }); if (state.failBuild) throw Error("fixture private build detail"); await fs.mkdir(path.join(stage, ".next")); await fs.writeFile(path.join(stage, ".next/BUILD_ID"), "new-build"); }
  };
  return { root, c, appRoot, release, app, shared, payload, options, state, secret, run: () => runManagedUpdate(c, payload, options) };
}

test("UI and native target recovery use only the same client's successful pinned installation", () => {
  const target = { host: "192.0.2.55", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/one", fingerprint: "SHA256:" + "A".repeat(43) }, clientId = uuid();
  const installed = { clientId, phase: "succeeded", target }, blank = { ...target, appPath: "" };
  assert.equal(resolveManagedUpdateTarget(blank, installed, clientId).appPath, target.appPath);
  assert.equal(ui.installedUpdateTarget(blank, installed, clientId).appPath, target.appPath);
  for (const changed of [{ ...blank, host: "192.0.2.56" }, { ...blank, fingerprint: "" }, { ...blank, appPath: "/srv/lms-core/clients/other" }]) assert.throws(() => resolveManagedUpdateTarget(changed, installed, clientId), /SSH/);
  assert.equal(ui.installedUpdateTarget(blank, installed, uuid()).appPath, "");
  assert.throws(() => resolveManagedUpdateTarget(blank, installed, uuid()), /клиента/);
});

for (const linked of [false, true]) test(`managed update keeps backend, client data and ${linked ? "linked" : "regular"} settings`, async t => {
  const f = await fixture(t, linked), result = await f.run();
  assert.equal(result.phase, "succeeded"); assert.equal(await fs.readFile(path.join(f.app, "interface.txt"), "utf8"), "selected-new-git");
  assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), f.secret);
  assert.equal(await fs.readFile(path.join(result.backupPath, "interface.txt"), "utf8"), "old-interface");
  assert.equal(await fs.readFile(path.join(f.release, "backend/baseline.sql"), "utf8"), "unchanged-schema"); assert.equal(await fs.readFile(path.join(f.shared, "database-sentinel"), "utf8"), "existing-client-data");
  assert.deepEqual(f.state.calls, ["is-active", "is-active", "stop", "start", "is-active"]);
  const receipt = await fs.readFile(path.join(f.shared, "web-update-receipt.json"), "utf8"); assert.equal(JSON.parse(receipt).revision, f.c.revision); assert.ok(!receipt.includes("fixture-secret"));
  await assert.rejects(fs.stat(path.join(f.shared, "ai-configuration.lock")), { code: "ENOENT" });
});

test("failed build never stops the old website and cleans its own staging", async t => {
  const f = await fixture(t); f.state.failBuild = true; const result = await f.run();
  assert.equal(result.phase, "failed"); assert.equal(result.failedStep, "building"); assert.ok(!f.state.calls.includes("stop"));
  assert.equal(await fs.readFile(path.join(f.app, "interface.txt"), "utf8"), "old-interface"); assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), f.secret);
  await assert.rejects(fs.stat(path.join(f.release, `.web-update-${f.c.id}`)), { code: "ENOENT" });
});

test("failed new health restores the exact prior app, env and service", async t => {
  const f = await fixture(t, true); f.state.failHealth = true; const result = await f.run();
  assert.equal(result.phase, "rolled_back"); assert.equal(result.errorCode, "UPDATE_HEALTH_FAILED");
  assert.equal(await fs.readFile(path.join(f.app, "interface.txt"), "utf8"), "old-interface"); assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), f.secret);
  assert.equal(await fs.readlink(path.join(f.app, ".env.production.local")), path.join(f.shared, "ai.env"));
  await assert.rejects(fs.stat(path.join(f.shared, "web-update-receipt.json")), { code: "ENOENT" });
});

test("active configuration lock, incompatible backend and existing design fail before stopping", async t => {
  const f = await fixture(t); const lock = path.join(f.shared, "ai-configuration.lock"); await fs.writeFile(lock, "other-operation");
  await assert.rejects(f.run(), { code: "MANAGED_CONFIGURATION_BUSY" }); assert.equal(await fs.readFile(lock, "utf8"), "other-operation"); await fs.unlink(lock);
  await fs.writeFile(path.join(f.payload, "backend/baseline.sql"), "different-schema"); assert.equal((await f.run()).errorCode, "UPDATE_BACKEND_MIGRATION_REQUIRED");
  await fs.writeFile(path.join(f.payload, "backend/baseline.sql"), "unchanged-schema"); await fs.writeFile(path.join(f.app, "core-client-design.json"), "{}"); assert.equal((await f.run()).errorCode, "UPDATE_DESIGN_REBASE_REQUIRED");
  assert.ok(!f.state.calls.includes("stop"));
});

test("foreign installation and unsafe data links cannot be adopted", async t => {
  const f = await fixture(t); const file = path.join(f.appRoot, ".core-install-owner.json"), owner = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...owner, clientId: uuid() })); await assert.rejects(f.run(), { code: "AI_OWNER_MISMATCH" }); assert.ok(!f.state.calls.includes("stop"));
  await fs.writeFile(file, JSON.stringify(owner)); await fs.mkdir(path.join(f.app, "data")); await fs.symlink("/etc/passwd", path.join(f.app, "data/foreign"));
  const result = await f.run(); assert.equal(result.phase, "rolled_back"); assert.equal(result.errorCode, "UPDATE_DATA_LINK_UNSAFE"); assert.equal(await fs.readFile(path.join(f.app, "interface.txt"), "utf8"), "old-interface");
});

async function nativeFixture(t, outcome = "succeeded") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-managed-native-"));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("core-managed-native-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  for (const name of ["lms-managed-update.cjs", "configure-lms-ai.cjs", "lms-new-install-worker.cjs", "lms-update-worker.cjs", "lms-install-job.cjs", "runtime-process.cjs", "client-design-contract.cjs", "point-design-contract.cjs"]) await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts", name), path.join(root, "infra/scripts", name));
  const clientId = uuid(), target = { host: "192.0.2.55", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/native", fingerprint: "SHA256:" + "A".repeat(43) }, installed = { id: uuid(), clientId, phase: "succeeded", releaseId: uuid(), webPort: 3000, target };
  const archivePath = path.join(root, "package.tar"); await fs.writeFile(archivePath, "fixture-selected-code"); const pkg = { id: uuid(), sourceId: uuid(), revision: "d".repeat(40), sha256: sha("fixture-selected-code"), archiveBytes: 21, archivePath };
  const calls = [], auth = { mode: "password", password: "private-ssh-fixture" };
  const remote = { withSession: async (actual, credentials, callback) => { assert.deepEqual(actual, target); assert.equal(credentials.password, "private-ssh-fixture"); return callback({ execute: async (command, input) => {
    calls.push({ command, input }); if (command.startsWith("nohup") && outcome === "disconnect") throw Error("private transport text");
    const id = /\/jobs\/([a-f0-9-]{36})/.exec(command)?.[1];
    if (command.startsWith("cat") || command === "node -" && String(input).includes("worker.pid")) return JSON.stringify({ id: id || /\/jobs\/([a-f0-9-]{36})/.exec(input)[1], clientId, phase: outcome === "disconnect" ? "succeeded" : outcome, updatedAt: new Date().toISOString(), privateSecret: "private-ssh-fixture" });
    return "";
  } }); } };
  const service = new ManagedUpdateService(root, remote, { get: async () => installed }, { prepare: async () => pkg, verify: async () => pkg }, async () => true, async () => {});
  return { root, service, clientId, target, calls, auth, installed };
}

test("native service packages the selected revision, routes by client and never persists credentials", async t => {
  const f = await nativeFixture(t); const result = await f.service.deploy(f.clientId, { ...f.target, appPath: "" }, f.auth, uuid(), () => {});
  assert.equal(result.phase, "succeeded"); assert.equal(result.managed, true); assert.equal(result.revision, "d".repeat(40)); assert.equal(result.target.appPath, f.target.appPath); assert.equal(f.auth.password, undefined);
  assert.ok(f.calls.some(call => call.command.startsWith("nohup"))); assert.ok(!f.calls.some(call => String(call.input).includes("private-ssh-fixture")));
  const text = await fs.readFile(path.join(f.root, "infra/runtime/managed-updates", `${f.clientId}.json`), "utf8"); assert.ok(!text.includes("privateSecret") && !text.includes("private-ssh-fixture"));
});

test("uncertain detached launch blocks a blind repeat and can be read without reinstall", async t => {
  const f = await nativeFixture(t, "disconnect"); assert.equal((await f.service.deploy(f.clientId, f.target, { ...f.auth }, uuid(), () => {})).phase, "disconnected");
  await assert.rejects(f.service.deploy(f.clientId, f.target, { ...f.auth }, uuid(), () => {}), /результат предыдущего/);
  const refreshed = await f.service.refresh(f.clientId, f.target, { ...f.auth }, () => {});
  assert.equal(refreshed.phase, "succeeded"); assert.equal(refreshed.errorCode, undefined);
});
