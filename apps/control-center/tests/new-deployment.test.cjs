const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { assertNewInstallationReady, NewDeploymentService } = require("../dist/new-deployment.js");
const { validateArchiveListing } = require("../../../infra/scripts/lms-install-job.cjs");
const { installationConfiguration } = require("../dist/installation-client.js");
const { normalizeFreshClient } = require("../../../packages/db/dist/src/index.js");

async function fixture(t, failLaunch = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-new-job-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-new-job-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  for (const name of ["lms-install-job.cjs", "lms-new-install-worker.cjs", "runtime-process.cjs", "source-curriculum.cjs", "resume-lms-installation.cjs", "client-design-contract.cjs", "database-preflight.cjs", "recover-failed-installation.cjs", "inspect-empty-installation.cjs"]) await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts", name), path.join(root, "infra/scripts", name));
  const id = crypto.randomUUID(), releaseId = crypto.randomUUID(), snapshotId = crypto.randomUUID(), planId = crypto.randomUUID();
  const bytes = Buffer.from("fixture code archive"), archive = path.join(root, "fixture.tar"); await fs.writeFile(archive, bytes);
  const pkg = { id: releaseId, sourceId: crypto.randomUUID(), revision: "a".repeat(40), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), archiveBytes: bytes.length, archivePath: archive };
  const target = { host: "127.0.0.1", port: 22822, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/fixture-client", fingerprint: "SHA256:" + "A".repeat(43) };
  const client = normalizeFreshClient({ id, slug: "fixture-client", name: "Fixture", domain: "fixture.invalid", brandName: "Fixture", tariff: "base", industryTemplate: "coffee_shop" });
  const plan = { id: planId, client, clientConfiguration: installationConfiguration(client), contentMode: "empty", admins: { clientLogin: "fixture.admin", systemLogin: "fixture.system" }, target, status: "prepared", package: pkg, source: { snapshotId, revision: pkg.revision }, preflight: { checkedAt: new Date().toISOString(), apiPort: 4101, candidatePort: 3000 } };
  const calls = [], access = { ready: true }, outcome = { phase: "succeeded" }; let jobId = "";
  const remote = { withSession: async (target, auth, operation) => operation({ execute: async (command, input) => {
    calls.push({ command, input }); jobId ||= (String(input).match(/\/srv\/lms-core\/jobs\/([a-f0-9-]{36})/) || command.match(/\/srv\/lms-core\/jobs\/([a-f0-9-]{36})/))?.[1] || "";
    if (command.startsWith("node -e ")) { if (access.transportError) throw Error("fixture-secret-raw transport failure"); return JSON.stringify(access); }
    if (String(input).includes("recovery.inspectRecovery(")) return JSON.stringify({ clientId: id, jobId, phase: "retry_available", retryAvailable: true });
    if (String(input).includes("check.inspectEmptyInstallation(")) return JSON.stringify({ clientId: id, jobId, releaseId, empty: true });
    if (String(input).includes(".resumeBootstrappedInstallation(")) return JSON.stringify(String(input).includes("{inspect:true}")
      ? { clientId: id, jobId, releaseId, phase: "checked", resumeAvailable: true }
      : { id: jobId, clientId: id, releaseId, phase: "succeeded", errorCode: null, failedStep: null, updatedAt: new Date().toISOString() });
    if (String(input).includes("recovery.recoverFailedInstallation(")) return JSON.stringify({ clientId: id, jobId, phase: "retry_available", retryAvailable: true });
    if (command.includes("--launch")) { if (failLaunch) throw Error("fixture-secret-raw"); return JSON.stringify({ launched: true, id: jobId }); }
    if (command.startsWith("cat ") || command === "node -" && String(input).includes("worker.pid")) return JSON.stringify({ id: jobId, clientId: id, releaseId, ...outcome, updatedAt: new Date().toISOString(), password: "fixture-secret-raw" });
    return "";
  } }) };
  const key = crypto.randomBytes(32);
  const codec = { available: () => true, encrypt: (text) => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); } };
  const service = (currentDesignHash) => new NewDeploymentService(root, remote, { get: async () => plan }, { verify: async () => pkg }, codec, async () => {}, undefined, currentDesignHash);
  const secret = () => ({ maintenanceUrl: "postgresql://postgres:fixture-secret-raw@127.0.0.1/postgres", clientAdminLogin: "fixture.admin", clientAdminName: "Fixture", clientAdminPassword: "fixture-password-long", systemAdminLogin: "fixture.system", systemAdminPassword: "fixture-password-system" });
  return { root, service, client, plan, target, calls, secret, codec, pkg, access, outcome };
}
test("failed provisioning is diagnosed automatically and guarded recovery unlocks a retry", async t => {
  const f = await fixture(t); Object.assign(f.outcome, { phase: "needs_attention", failedStep: "initialize", errorCode: "DATABASE_PROVISION_UNCONFIRMED" });
  const service = f.service();
  const stopped = await service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  assert.equal(stopped.retryAvailable, true); assert.match(stopped.message, /Восстановить запуск/);
  await assert.rejects(service.recover(f.client.id, f.target, { mode: "password" }, () => {}));
  const bytes = await fs.readFile(path.join(f.root, "infra/scripts/recover-failed-installation.cjs"));
  await fs.writeFile(path.join(f.root, "infra/runtime/recovery-acceptance.json"), JSON.stringify({ accepted: true, realLinuxAccount: true, fixtureCleaned: true, workerSha256: crypto.createHash("sha256").update(bytes).digest("hex") }));
  const result = await service.recover(f.client.id, f.target, { mode: "password" }, () => {});
  assert.equal(result.phase, "failed"); assert.equal(result.retryAvailable, false); assert.equal(result.errorCode, "INSTALLATION_RETRY_READY");
  assert.equal((await service.get(f.client.id)).phase, "failed");
});

test("the uploaded bootstrap is independently runnable and contains the exact curriculum dependency", async t => {
  const f = await fixture(t);
  await f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  const setup = f.calls.find(call => call.command === "node -" && call.input.includes("process.umask")).input;
  const encoded = JSON.parse(setup.match(/Object\.entries\((\{[^\n]+?\})\)/)[1]);
  assert.equal(encoded["source-curriculum.cjs"], (await fs.readFile(path.join(f.root, "infra/scripts/source-curriculum.cjs"))).toString("base64"));
  const directory = path.join(f.root, "isolated-upload"); await fs.mkdir(directory);
  for (const [name, bytes] of Object.entries(encoded)) await fs.writeFile(path.join(directory, name), Buffer.from(bytes, "base64"));
  const result = require("node:child_process").execFileSync(process.execPath, ["-e", "require(process.argv[1]);process.stdout.write('DEPENDENCIES_READY')", path.join(directory, "lms-new-install-worker.cjs")], { windowsHide: true, encoding: "utf8" });
  assert.equal(result, "DEPENDENCIES_READY");
  await fs.unlink(path.join(directory, "source-curriculum.cjs"));
  assert.throws(() => require("node:child_process").execFileSync(process.execPath, ["-e", "require(process.argv[1])", path.join(directory, "lms-new-install-worker.cjs")], { windowsHide: true, stdio: "pipe" }), error => error.stderr.toString().includes("MODULE_NOT_FOUND"));
});

test("Core offers guarded post-bootstrap continuation and clears the stale failure after success", async t => {
  const f = await fixture(t); Object.assign(f.outcome, { phase: "needs_attention", failedStep: "bootstrap", errorCode: "CURRICULUM_INSTALL_VERIFY_FAILED" });
  const service = f.service(), stopped = await service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  assert.equal(stopped.retryAvailable, true); assert.match(stopped.message, /сохранив БД/);
  assert.match((await service.get(f.client.id)).message, /без удаления БД/);
  await assert.rejects(service.recover(f.client.id, f.target, { mode: "password" }, () => {}));
  const dependencies = {};
  for (const name of ["resume-lms-installation.cjs", "lms-new-install-worker.cjs", "runtime-process.cjs", "source-curriculum.cjs"]) dependencies[name] = crypto.createHash("sha256").update(await fs.readFile(path.join(f.root, "infra/scripts", name))).digest("hex");
  const gate = { accepted: true, fixtureCleaned: true, dependencies, results: ["empty", "source"].map(mode => ({ mode, realPostgres: true, realApi: true, realSystemd: true, vaultPreserved: true, accountsPreserved: true, curriculumVerified: true })) };
  await fs.writeFile(path.join(f.root, "infra/runtime/bootstrap-resume-acceptance.json"), JSON.stringify(gate));
  const result = await service.recover(f.client.id, f.target, { mode: "password" }, () => {});
  assert.equal(result.phase, "succeeded"); assert.equal(result.errorCode, undefined); assert.equal(result.failedStep, undefined); assert.equal(result.retryAvailable, false);
  const saved = await service.get(f.client.id); assert.equal(saved.errorCode, undefined); assert.equal(saved.phase, "succeeded");
});
test("bad database credentials fail before remote setup/upload/build and allow an ordinary retry", async t => {
  const f = await fixture(t); f.access.ready = false; f.access.errorCode = "DATABASE_ADMIN_CONNECTION_FAILED";
  const service = f.service(), failed = await service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  assert.equal(failed.phase, "failed"); assert.equal(failed.errorCode, "DATABASE_ADMIN_CONNECTION_FAILED");
  assert.match(failed.message, /SSH и пароль PostgreSQL/); assert.equal(f.calls.length, 1); assert.ok(f.calls[0].command.startsWith("node -e "));
  f.access.ready = true; assert.equal((await service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {})).phase, "succeeded");
});

test("changed client settings, missing snapshot and changed admin logins cannot create a job or SSH session", async t => {
  const f = await fixture(t), service = f.service();
  for (const change of [{ brandName: "Changed" }, { tariff: "extended" }, { includedUsers: 30 }, { domain: "another.invalid" }]) {
    await assert.rejects(service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), { ...f.client, ...change }, () => {}), /Карточка клиента изменилась/);
  }
  const saved = f.plan.clientConfiguration; delete f.plan.clientConfiguration;
  await assert.rejects(service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {}), /полного снимка/);
  f.plan.clientConfiguration = saved;
  for (const field of ["clientAdminLogin", "systemAdminLogin"]) {
    await assert.rejects(service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, { ...f.secret(), [field]: "other.login" }, f.client, () => {}), /Логины администраторов изменились/);
  }
  assert.equal(f.calls.length, 0); assert.equal(await service.get(f.client.id), null);
});

test("known missing local PostgreSQL stops before a new job or connection, but does not block an explicit external database", async t => {
  const f = await fixture(t), service = f.service();
  f.plan.preflight.postgresState = "missing";
  const local = f.secret(); delete local.maintenanceUrl; local.databaseMode = "local_peer";
  await assert.rejects(service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, local, f.client, () => {}), /PostgreSQL не установлена/);
  assert.equal(f.calls.length, 0); assert.equal(await service.get(f.client.id), null);
  assert.equal((await service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {})).phase, "succeeded");
});

test("database transport failure reports the exact safe stage and never exposes private transport text", async t => {
  const f = await fixture(t); f.access.transportError = true;
  const result = await f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  assert.equal(result.phase, "failed"); assert.equal(result.failedStep, "database_check");
  assert.equal(result.errorCode, "INSTALL_DATABASE_CHECK_FAILED");
  assert.ok(!JSON.stringify(result).includes("fixture-secret-raw")); assert.equal(f.calls.length, 1);
});

test("legacy namespace migration permits traversal without listing and refuses exposed child files", async t => {
  const f = await fixture(t);
  await f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  const setup = f.calls.find(call => call.command === "node -" && call.input.includes("process.umask")).input;
  const evaluate = exposed => {
    const entries = new Map([["/srv", { mode: 0o755, directory: true }], ["/srv/lms-core", { mode: 0o700, directory: true }], ["/srv/lms-core/clients", { mode: 0o700, directory: true }], ["/srv/lms-core/preparations", { mode: 0o700, directory: true }]]);
    if (exposed) entries.set("/srv/lms-core/private.env", { mode: 0o644, directory: false });
    const fakeFs = {
      existsSync: file => entries.has(file),
      mkdirSync: (file, options) => entries.set(file, { mode: options.mode, directory: true }),
      lstatSync: file => ({ ...entries.get(file), uid: 0, isDirectory: () => entries.get(file).directory, isSymbolicLink: () => false }),
      readdirSync: file => [...entries.keys()].filter(name => path.posix.dirname(name) === file).map(name => path.posix.basename(name)),
      chmodSync: (file, mode) => { entries.get(file).mode = mode; },
      writeFileSync: (file, _bytes, options) => entries.set(file, { mode: options.mode, directory: false })
    };
    const execute = () => require("node:vm").runInNewContext(setup, { require: name => { assert.equal(name, "node:fs"); return fakeFs; }, Buffer, process: { platform: "linux", getuid: () => 0, umask: () => {}, exit: () => { throw Error("UNSAFE_NAMESPACE"); } } });
    if (exposed) { assert.throws(execute, /UNSAFE_NAMESPACE/); assert.equal(entries.get("/srv/lms-core").mode, 0o700); }
    else { execute(); assert.equal(entries.get("/srv/lms-core").mode, 0o711); assert.equal(entries.get("/srv/lms-core/clients").mode, 0o711); assert.equal(entries.get("/srv/lms-core/preparations").mode, 0o700); }
  };
  evaluate(false); evaluate(true);
});

test("a namespace refusal unlocks retry only after an exact empty-resource inspection", async t => {
  const f = await fixture(t); Object.assign(f.outcome, { phase: "needs_attention", failedStep: "reserve", errorCode: "NAMESPACE_NOT_TRAVERSABLE" });
  const result = await f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  assert.equal(result.phase, "failed"); assert.equal(result.errorCode, "INSTALL_NAMESPACE_RETRY_READY");
});

test("server check expiry names only step 3 and keeps the prepared plan and package untouched", async (t) => {
  const f = await fixture(t), service = f.service();
  f.plan.preflight.checkedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const before = JSON.stringify(f.plan), auth = { mode: "password", password: "fixture-ssh-secret" }, secrets = f.secret();
  await assert.rejects(service.start(f.client.id, f.plan.id, f.target, auth, secrets, f.client, () => {}), /Нажмите только «3\. Проверить сервер».*План и пакет пересоздавать не нужно/);
  assert.equal(JSON.stringify(f.plan), before);
  assert.equal(f.calls.length, 0);
  assert.equal(await service.get(f.client.id), null);
  assert.equal(auth.password, undefined);
  assert.equal(secrets.clientAdminPassword, "");
  await assert.rejects(fs.stat(path.join(f.root, "infra/runtime/new-deployments")), { code: "ENOENT" });
  f.plan.preflight.checkedAt = new Date().toISOString();
  assert.equal((await service.start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {})).phase, "succeeded");
});

test("readiness time guard accepts the exact boundary and rejects absent, invalid, future or expired checks", async (t) => {
  const f = await fixture(t), now = Date.parse("2026-10-29T12:00:00Z");
  const check = () => assertNewInstallationReady(f.plan, f.plan.id, f.target, f.client, now);
  for (const age of [0, 599999, 600000]) {
    f.plan.preflight.checkedAt = new Date(now - age).toISOString();
    assert.doesNotThrow(check);
  }
  for (const timestamp of [new Date(now - 600001).toISOString(), new Date(now + 1).toISOString(), "invalid", ""]) {
    f.plan.preflight.checkedAt = timestamp;
    assert.throws(check, /3\. Проверить сервер/);
  }
  f.plan.preflight = null;
  assert.throws(check, /3\. Проверить сервер/);
});

test("readiness distinguishes missing package and changed identity from an expired check", async (t) => {
  const f = await fixture(t);
  const check = (plan = f.plan, planId = f.plan.id, target = f.target, client = f.client) => assertNewInstallationReady(plan, planId, target, client);
  for (const key of ["host", "port", "username", "basePath", "fingerprint"]) {
    const target = { ...f.target, [key]: key === "port" ? 22823 : "changed" };
    assert.throws(() => check(f.plan, f.plan.id, target), /SSH-параметры изменились/);
  }
  assert.throws(() => check(null), /SSH-параметры изменились/);
  assert.throws(() => check(f.plan, crypto.randomUUID()), /SSH-параметры изменились/);
  assert.throws(() => check(f.plan, f.plan.id, f.target, { ...f.client, id: crypto.randomUUID() }), /SSH-параметры изменились/);
  assert.throws(() => check(f.plan, f.plan.id, f.target, { ...f.client, slug: "other" }), /SSH-параметры изменились/);
  delete f.plan.package;
  assert.throws(() => check(), /2\. Собрать пакет/);
  f.plan.package = f.pkg;
  f.plan.status = "blocked";
  assert.throws(() => check(), /Не все условия/);
  assert.equal(f.calls.length, 0);
});

test("design-bound install refuses stale or foreign design before SSH or secret persistence", async (t) => {
  const f = await fixture(t), digest = "d".repeat(64);
  f.plan.presentationMode = "custom";
  f.plan.design = { id: crypto.randomUUID(), version: 1, clientId: f.client.id, sha256: digest, source: "saved" };
  f.pkg.design = { ...f.plan.design, supportedTextKeys: ["homeTitle"] };
  const start = (current) => f.service(async () => current).start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  await assert.rejects(start("e".repeat(64)), /Оформление/);
  f.pkg.design.clientId = crypto.randomUUID();
  await assert.rejects(start(digest), /Оформление/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, "infra/runtime/new-deployments")), { code: "ENOENT" });
});

test("design-bound install sends job v2 with the exact frozen digest", async (t) => {
  const f = await fixture(t), digest = "d".repeat(64);
  f.plan.presentationMode = "custom";
  f.plan.design = { id: crypto.randomUUID(), version: 1, clientId: f.client.id, sha256: digest, source: "saved" };
  f.pkg.design = { ...f.plan.design, supportedTextKeys: ["homeTitle"] };
  assert.equal((await f.service(async () => digest).start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {})).phase, "succeeded");
  const setup = f.calls.find((call) => call.command === "node -" && call.input.includes("job.json"));
  assert.ok(setup.input.includes('\\"version\\":2'));
  assert.ok(setup.input.includes(digest));
  assert.ok(setup.input.includes("client-design-contract.cjs"));
});

test("source-mode install ignores unrelated legacy settings and does not send design files", async (t) => {
  const f = await fixture(t);
  f.plan.presentationMode = "source";
  const result = await f.service(async () => { throw Error("Legacy settings are irrelevant"); }).start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  assert.equal(result.phase, "succeeded");
  const setup = f.calls.find((call) => call.command === "node -" && call.input.includes("job.json"));
  assert.ok(setup.input.includes('\\"version\\":1'));
  assert.equal(setup.input.includes("client-design-contract.cjs"), false);
});

test("unmarked legacy personalization cannot launch a job even if a cached plan says prepared", async (t) => {
  const f = await fixture(t), digest = "d".repeat(64);
  f.plan.design = { id: crypto.randomUUID(), version: 1, clientId: f.client.id, sha256: digest, source: "default" };
  f.pkg.design = { ...f.plan.design, supportedTextKeys: [] };
  await assert.rejects(f.service(async () => digest).start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {}), /старое оформление/);
  assert.equal(f.calls.length, 0);
});

test("NEW job sends secrets only to private stdin and stores a public result across reopening", async (t) => {
  const f = await fixture(t), service = f.service(), secrets = f.secret(), auth = { mode: "password", password: "fixture-ssh-secret" };
  const state = await service.start(f.client.id, f.plan.id, f.target, auth, secrets, f.client, () => {});
  assert.equal(state.phase, "succeeded"); assert.equal(secrets.maintenanceUrl, ""); assert.equal(auth.password, undefined);
  const launch = f.calls.find((call) => call.command.includes("--launch")); assert.ok(launch.input.includes("fixture-secret-raw"));
  assert.ok(!f.calls.some((call) => call.command.includes("fixture-secret-raw")));
  assert.ok(!f.calls.filter((call) => call.command === "node -").some((call) => call.input.includes("fixture-secret-raw")));
  const text = await fs.readFile(path.join(f.root, "infra/runtime/new-deployments", f.client.id + ".json"), "utf8");
  assert.ok(!text.includes("fixture-secret-raw") && !text.includes("fixture-password"));
  assert.equal((await f.service().get(f.client.id)).id, state.id);
  assert.equal((await f.service().refresh(f.client.id, f.target, { mode: "password" }, () => {})).phase, "succeeded");
  await assert.rejects(f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {}));
});

test("disconnect after launch blocks duplicate deployment and remote error text is never persisted", async (t) => {
  const f = await fixture(t, true);
  const state = await f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {});
  assert.equal(state.phase, "disconnected");
  assert.ok(!JSON.stringify(state).includes("fixture-secret-raw"));
  const count = f.calls.length;
  await assert.rejects(f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {}));
  await assert.rejects(f.service().refresh(f.client.id, { ...f.target, host: "other.invalid" }, { mode: "password" }, () => {}));
  assert.equal(f.calls.length, count);
});

test("external hosts, stale checks and unavailable OS encryption are rejected before SSH", async (t) => {
  const f = await fixture(t);
  f.target.host = "real-server.invalid";
  await assert.rejects(f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {}));
  f.target.host = "127.0.0.1"; f.plan.preflight.checkedAt = "2000-01-01T00:00:00Z";
  await assert.rejects(f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {}));
  f.plan.preflight.checkedAt = new Date().toISOString(); f.codec.available = () => false;
  await assert.rejects(f.service().start(f.client.id, f.plan.id, f.target, { mode: "password" }, f.secret(), f.client, () => {}));
  assert.equal(f.calls.length, 0);
});

test("archive extraction refuses traversal, unexpected roots and links", () => {
  validateArchiveListing("./\n./lms/\n./lms/package.json\n", "drwxr-xr-x root/root 0 folder\n-rw-r--r-- root/root 20 file\n");
  for (const name of ["../escape", "/etc/passwd", "./lms/../../escape", "./other/file", "lms\\file"]) assert.throws(() => validateArchiveListing(name + "\n", "-rw-r--r-- fixture\n"));
  for (const type of ["l", "h", "b", "c"]) assert.throws(() => validateArchiveListing("lms/file\n", type + "rwx fixture\n"));
});
