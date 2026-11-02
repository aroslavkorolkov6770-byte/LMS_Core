const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { executeNewInstall, createInstallDriver, verifyPackage, validateJob, readSecretInput, stopPrivateGroup, InstallError } = require("../../../infra/scripts/lms-new-install-worker.cjs");
const { sealSecrets, openSecrets, roleEnvironment } = require("../../../infra/scripts/runtime-process.cjs");
const stages = ["validate", "reserve", "build", "initialize", "bootstrap", "configure", "activate", "health", "commit"];
const password = () => crypto.randomBytes(24).toString("base64url");

test("new installation builds before database/bootstrap/services and never calls an old-site stop", async () => {
  const events = [];
  const driver = Object.fromEntries(stages.map((stage) => [stage, async () => events.push(stage)]));
  driver.cleanup = async () => events.push("cleanup");
  assert.equal((await executeNewInstall(driver)).phase, "succeeded");
  assert.deepEqual(events, stages);
});
for (const failed of stages) test(`new-install failure at ${failed} stops only owned services and never deletes SQL`, async () => {
  const events = [];
  const driver = Object.fromEntries(stages.map((stage) => [stage, async () => { events.push(stage); if (stage === failed) throw new InstallError("FIXTURE_FAILURE"); }]));
  driver.cleanup = async () => events.push("cleanup");
  const result = await executeNewInstall(driver);
  assert.equal(result.phase, stages.indexOf(failed) >= stages.indexOf("reserve") ? "needs_attention" : "failed");
  assert.equal(result.failedStep, failed);
  assert.equal(events.at(-1), "cleanup");
  assert.equal(events.includes("deleteDatabase"), false);
});
test("a failed status write cannot be reported as a successful new installation", async () => {
  const driver = Object.fromEntries(stages.map((stage) => [stage, async () => {}])); driver.cleanup = async () => {};
  const result = await executeNewInstall(driver, () => { throw Error("fixture"); });
  assert.equal(result.errorCode, "STATUS_WRITE_FAILED"); assert.notEqual(result.phase, "succeeded");
});
test("runtime vault authenticates tenant identity and web process never receives DB/key/bootstrap passwords", () => {
  const key = crypto.randomBytes(32), id = crypto.randomUUID();
  const secrets = { databaseUrl: "postgresql://fixture.invalid/db", serviceToken: password(), encryptionKey: crypto.randomBytes(32).toString("hex"), authSecret: password() };
  const envelope = sealSecrets(secrets, key, id);
  assert.deepEqual(openSecrets(envelope, key, id), secrets);
  assert.equal(JSON.stringify(envelope).includes(secrets.serviceToken), false);
  assert.throws(() => openSecrets(envelope, key, crypto.randomUUID()));
  const web = roleEnvironment({ clientId: id, releaseId: crypto.randomUUID(), apiPort: 4101, webPort: 3005 }, secrets, "web");
  assert.equal(web.DATABASE_URL, undefined); assert.equal(web.LMS_RUNTIME_ENCRYPTION_KEY, undefined); assert.equal(web.LMS_RUNTIME_BOOTSTRAP_ENABLED, undefined);
  assert.equal(web.APP_ORIGIN, "http://127.0.0.1:3005");
  assert.equal(roleEnvironment({ clientId: id, apiPort: 4101 }, secrets, "api").LMS_RUNTIME_REQUIRE_RESTRICTED_ROLE, "true");
});

async function free() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
async function fixture(t, failCommand, withDesign = false, contentMode = "empty") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-new-install-"));
  await fs.chmod(directory, 0o755);
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("core-new-install-")); await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const pkg = path.join(directory, "package"), base = path.join(directory, "clients"), units = path.join(directory, "systemd");
  await fs.mkdir(pkg); await fs.mkdir(units);
  const job = { version: 1, id: crypto.randomUUID(), releaseId: crypto.randomUUID(), client: { id: crypto.randomUUID(), name: "Local fixture", brandName: "Fixture", slug: "local-fixture", domain: "fixture.invalid", tariff: "base", industryTemplate: "coffee_shop" }, apiPort: await free(), webPort: await free() };
  const secret = { databaseUrl: "postgresql://fixture.invalid/db", clientAdminName: "Fixture", clientAdminLogin: "fixture.admin", clientAdminPassword: password(), systemAdminLogin: "fixture.system", systemAdminPassword: password() };
  const data = { "lms/package.json": JSON.stringify({ scripts: { build: "next build", start: "next start" } }), "lms/package-lock.json": "{}",
    "lms/app/api/core-runtime/health/route.ts": "export const GET = () => {};", "lms/app/lib/storage/dataStore.ts": "export const fixture = true;",
    "backend/runtime-api.cjs": "// isolated fixture", "backend/runtime-init.cjs": "// isolated fixture", "backend/runtime-provision.cjs": "// isolated fixture", "backend/baseline.sql": "-- fixture", "backend/baseline-manifest.json": "{}",
    "installer/runtime-process.cjs": "// isolated fixture", "installer/lms-new-install-worker.cjs": "// isolated fixture",
    "installer/source-curriculum.cjs": await fs.readFile(path.resolve(__dirname, "../../../infra/scripts/source-curriculum.cjs"), "utf8") };
  job.contentMode = contentMode;
  let curriculum;
  if (contentMode === "source") {
    const helper = require("../../../infra/scripts/source-curriculum.cjs");
    const bundle = { version: 1, revision: "a".repeat(40), entries: [{ key: "core_lms_route_v1", data: [{ id: "topic", title: "Git topic" }] },
      { key: "core_lms_tests_v1", data: [{ id: "test", title: "Git test", quiz: [{ q: "Question", o: ["A", "B"], c: 0 }] }] }] };
    curriculum = helper.curriculumSummary(bundle);
    data["installer/source-curriculum.json"] = JSON.stringify(bundle);
    data["installer/source-curriculum.cjs"] = await fs.readFile(path.resolve(__dirname, "../../../infra/scripts/source-curriculum.cjs"), "utf8");
  }
  let design;
  if (withDesign) {
    const contract = require("../../../infra/scripts/client-design-contract.cjs");
    const settings = require("../../../packages/shared/dist/index.js").mergeClientPreviewSettings({});
    const imageBytes = withDesign === "image" ? require("./branding-image-fixture.cjs").fixtureImage() : null;
    const imageHash = imageBytes ? crypto.createHash("sha256").update(imageBytes).digest("hex") : "";
    const assets = imageBytes ? [{ path: `core-branding/${imageHash}.png`, sha256: imageHash, bytes: imageBytes.length, mime: "image/png" }] : [];
    const doc = contract.createClientDesign({ clientId: job.client.id, brandName: job.client.brandName, settings, assets, imageUrl: imageBytes ? `/${assets[0].path}` : "" });
    if (imageBytes) data[`lms/public/${assets[0].path}`] = imageBytes;
    job.version = 2; job.designSha256 = contract.designHash(doc);
    design = { id: crypto.randomUUID(), version: doc.version, clientId: job.client.id, sha256: job.designSha256, supportedTextKeys: ["homeTitle"] };
    data["lms/core-client-design.json"] = JSON.stringify(doc);
    const code = await fs.readFile(path.resolve(__dirname, "../../../infra/scripts/client-design-contract.cjs"), "utf8");
    data["lms/core-client-design-contract.cjs"] = code; data["installer/client-design-contract.cjs"] = code;
  }
  const files = [];
  for (const [name, body] of Object.entries(data)) { await fs.mkdir(path.dirname(path.join(pkg, name)), { recursive: true }); await fs.writeFile(path.join(pkg, name), body); files.push({ path: name, sha256: crypto.createHash("sha256").update(body).digest("hex") }); }
  await fs.writeFile(path.join(pkg, "release-manifest.json"), JSON.stringify({ format: "lms-core-install-v1", id: job.releaseId, protocol: "lms-core-runtime-v1", contentMode, revision: "a".repeat(40), ...(curriculum ? { curriculum } : {}), targetBuildRequired: true, files, ...(design ? { design } : {}) }));
  const commands = [];
  const runtime = new Map([["core_lms_users_v1", { key: "core_lms_users_v1", found: true, revision: 1, data: [{ id: "fixture-admin" }] }]]);
  const fetch = async (url, options) => {
    if (url.includes("/api/lms-runtime/v1/")) {
      const input = JSON.parse(options.body);
      if (url.endsWith("/read")) return Response.json({ protocol: "lms-core-runtime-v1", entries: input.keys.map(key => structuredClone(runtime.get(key) || { key, found: false, revision: 0, data: null })) });
      assert.ok(["core_lms_route_v1", "core_lms_tests_v1"].includes(input.key));
      const revision = runtime.get(input.key)?.revision || 0;
      if (revision !== input.expectedRevision) return Response.json({}, { status: 409 });
      runtime.set(input.key, { key: input.key, found: true, revision: revision + 1, data: input.data });
      return Response.json({ protocol: "lms-core-runtime-v1", key: input.key, revision: revision + 1 });
    }
    return Response.json({ protocol: "lms-core-client-v1", clientId: job.client.id, releaseId: job.releaseId, storage: "postgresql-runtime" });
  };
  const run = async (file, args, options = {}) => {
    commands.push({ file, args, env: options.env });
    if (file === "id") throw Object.assign(Error("absent fixture user"), { code: 1 });
    if (failCommand?.(file, args)) throw Error("fixture command failure");
    if (args.some((value) => String(value).replaceAll("\\", "/").includes("node_modules/next/dist/bin/next")) && args.includes("build")) { await fs.mkdir(path.join(options.cwd, ".next")); await fs.writeFile(path.join(options.cwd, ".next/BUILD_ID"), "fixture"); }
    if (args.some((value) => String(value).endsWith("runtime-init.cjs"))) return { stdout: JSON.stringify({ initialized: true, reused: false, clientId: job.client.id }) };
    return { stdout: "", stderr: "" };
  };
  const driver = createInstallDriver(job, { ...secret }, pkg, { fixture: true, base, unitDirectory: units, run,
    bootstrap: async () => {}, healthTimeout: 1000, fetch });
  return { directory, pkg, base, units, job, secret, driver, commands, runtime, run, fetch };
}

async function interruptedBootstrap(t, mode = "empty") {
  const f = await fixture(t, undefined, false, mode);
  f.runtime.set("core_lms_route_v1", { key: "core_lms_route_v1", found: true, revision: 1, data: [{ id: "conflict", title: "Fixture conflict" }] });
  const stopped = await executeNewInstall(f.driver);
  assert.equal(stopped.failedStep, "bootstrap"); assert.equal(stopped.errorCode, "CURRICULUM_INSTALL_VERIFY_FAILED");
  f.runtime.delete("core_lms_route_v1");
  const jobRoot = path.join(f.directory, "jobs"), directory = path.join(jobRoot, f.job.id);
  await fs.mkdir(directory, { recursive: true });
  await fs.cp(f.pkg, path.join(directory, "payload"), { recursive: true });
  const archive = Buffer.from("isolated recovery fixture"); await fs.writeFile(path.join(directory, "code.tar"), archive);
  await fs.writeFile(path.join(directory, "job.json"), JSON.stringify({ job: f.job, sha256: crypto.createHash("sha256").update(archive).digest("hex") }));
  await fs.writeFile(path.join(directory, "status.json"), JSON.stringify({ id: f.job.id, clientId: f.job.client.id, releaseId: f.job.releaseId, ...stopped }));
  return { ...f, jobRoot, recoveryInput: { clientId: f.job.client.id, jobId: f.job.id, releaseId: f.job.releaseId, appPath: path.join(f.base, f.job.client.slug) },
    recoveryOptions: { fixture: true, jobRoot, base: f.base, unitDirectory: f.units, run: async (file, args, options) => file === "id" ? { stdout: "123" } : f.run(file, args, options), fetch: f.fetch, bootstrap: () => { throw Error("BOOTSTRAP_MUST_NOT_REPEAT"); } } };
}

for (const mode of ["empty", "source"]) test(`post-bootstrap ${mode} recovery preserves vault/accounts and never rebuilds or recreates SQL`, async t => {
  const f = await interruptedBootstrap(t, mode), resume = require("../../../infra/scripts/resume-lms-installation.cjs").resumeBootstrappedInstallation;
  const shared = path.join(f.base, f.job.client.slug, "shared"), key = await fs.readFile(path.join(shared, "runtime-vault.key"));
  const accounts = structuredClone(f.runtime.get("core_lms_users_v1")), beforeCommands = f.commands.length;
  const result = await resume(f.recoveryInput, f.recoveryOptions);
  assert.equal(result.phase, "succeeded", JSON.stringify(result)); assert.equal(result.resumedWithoutDatabaseReset, true);
  assert.deepEqual(await fs.readFile(path.join(shared, "runtime-vault.key")), key);
  assert.deepEqual(f.runtime.get("core_lms_users_v1"), accounts);
  assert.equal(f.commands.slice(beforeCommands).some(call => call.args.some(arg => /runtime-(?:init|provision)\.cjs$/.test(arg)) || call.args.includes("build") || call.args.includes("ci")), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(shared, "content-receipt.json"))).mode, mode);
  await assert.rejects(resume(f.recoveryInput, f.recoveryOptions), /RESUME_STAGE_NOT_SUPPORTED/);
});

for (const change of ["owner", "context", "vault", "content"]) test(`recovery refuses ${change} mismatch without resetting administrator records`, async t => {
  const f = await interruptedBootstrap(t), root = f.recoveryInput.appPath, shared = path.join(root, "shared");
  const accounts = structuredClone(f.runtime.get("core_lms_users_v1"));
  if (change === "owner") {
    const file = path.join(root, ".core-install-owner.json"), owner = JSON.parse(await fs.readFile(file)); owner.jobId = crypto.randomUUID(); await fs.writeFile(file, JSON.stringify(owner));
  } else if (change === "context") {
    const file = path.join(shared, "runtime-context.json"), context = JSON.parse(await fs.readFile(file)); context.apiPort++; await fs.writeFile(file, JSON.stringify(context));
  } else if (change === "vault") await fs.writeFile(path.join(shared, "runtime-vault.key"), crypto.randomBytes(32));
  else f.runtime.set("core_lms_tests_v1", { key: "core_lms_tests_v1", found: true, revision: 1, data: [{ id: "existing", title: "Preserve" }] });
  const resume = require("../../../infra/scripts/resume-lms-installation.cjs").resumeBootstrappedInstallation;
  if (change === "content") assert.equal((await resume(f.recoveryInput, f.recoveryOptions)).errorCode, "CURRICULUM_INSTALL_VERIFY_FAILED");
  else await assert.rejects(resume(f.recoveryInput, f.recoveryOptions), /RESUME_(?:OWNER|CONTEXT|VAULT)/);
  assert.deepEqual(f.runtime.get("core_lms_users_v1"), accounts); assert.deepEqual(await fs.readdir(f.units), []);
});

test("job v2 requires a design digest; legacy jobs cannot smuggle a digest", async (t) => {
  const f = await fixture(t);
  assert.throws(() => validateJob({ ...f.job, version: 2 }));
  assert.throws(() => validateJob({ ...f.job, designSha256: "d".repeat(64) }));
  assert.throws(() => validateJob({ ...f.job, version: 2, designSha256: "../design" }));
  assert.equal(validateJob({ ...f.job, version: 2, designSha256: "d".repeat(64) }).version, 2);
});

test("personalized install persists its design digest and isolates web/API environments", async (t) => {
  const f = await fixture(t, undefined, true);
  assert.equal((await executeNewInstall(f.driver)).phase, "succeeded");
  const context = JSON.parse(await fs.readFile(path.join(f.base, f.job.client.slug, "shared/runtime-context.json"), "utf8"));
  assert.equal(context.designSha256, f.job.designSha256);
  const secret = { databaseUrl: "postgresql://fixture.invalid/db", serviceToken: password(), encryptionKey: crypto.randomBytes(32).toString("hex"), authSecret: password() };
  assert.equal(roleEnvironment(context, secret, "web").CORE_RUNTIME_DESIGN_SHA256, context.designSha256);
  assert.equal(roleEnvironment(context, secret, "api").CORE_RUNTIME_DESIGN_SHA256, undefined);
  const next = path.join(context.releaseRoot, "lms/node_modules/next/dist/bin/next");
  await fs.mkdir(path.dirname(next), { recursive: true });
  await fs.writeFile(next, "process.stdout.write('OWNED_WEB_STARTED');");
  const contextFile = path.join(f.base, f.job.client.slug, "shared/runtime-context.json");
  const wrapper = path.resolve(__dirname, "../../../infra/scripts/runtime-process.cjs");
  assert.equal(execFileSync(process.execPath, [wrapper, contextFile, "web"], { encoding: "utf8", windowsHide: true }), "OWNED_WEB_STARTED");
  await fs.writeFile(contextFile, JSON.stringify({ ...context, designSha256: "e".repeat(64) }));
  assert.throws(() => execFileSync(process.execPath, [wrapper, contextFile, "web"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }), (error) => error.stderr.toString().includes("RUNTIME_WRAPPER_CONFIGURATION_FAILED") && !error.stdout.toString().includes("OWNED_WEB_STARTED"));
});

for (const mismatch of ["client", "digest"]) test(`personalized worker refuses ${mismatch} mismatch before creating resources`, async (t) => {
  const f = await fixture(t, undefined, true);
  if (mismatch === "client") f.job.client.id = crypto.randomUUID(); else f.job.designSha256 = "e".repeat(64);
  const result = await executeNewInstall(f.driver);
  assert.equal(result.phase, "failed"); assert.equal(result.errorCode, "JOB_DESIGN_MISMATCH");
  assert.equal(f.commands.length, 0);
  await assert.rejects(fs.stat(f.base), { code: "ENOENT" });
});

test("personalized image is verified in release and again before web boot", async (t) => {
  const f = await fixture(t, undefined, "image");
  assert.equal((await executeNewInstall(f.driver)).phase, "succeeded");
  const contextFile = path.join(f.base, f.job.client.slug, "shared/runtime-context.json"), context = JSON.parse(await fs.readFile(contextFile, "utf8"));
  const web = path.join(context.releaseRoot, "lms"), doc = JSON.parse(await fs.readFile(path.join(web, "core-client-design.json"), "utf8"));
  const next = path.join(web, "node_modules/next/dist/bin/next");
  await fs.mkdir(path.dirname(next), { recursive: true }); await fs.writeFile(next, "process.stdout.write('IMAGE_WEB_STARTED');");
  const wrapper = path.resolve(__dirname, "../../../infra/scripts/runtime-process.cjs");
  assert.equal(execFileSync(process.execPath, [wrapper, contextFile, "web"], { encoding: "utf8", windowsHide: true }), "IMAGE_WEB_STARTED");
  await fs.writeFile(path.join(web, "public", doc.assets[0].path), "changed");
  assert.throws(() => execFileSync(process.execPath, [wrapper, contextFile, "web"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }), (error) => !error.stdout.toString().includes("IMAGE_WEB_STARTED"));
});
test("real fixture filesystem is installed vertically into its own release, encrypted vault and new units", async (t) => {
  const f = await fixture(t);
  const result = await executeNewInstall(f.driver);
  assert.equal(result.phase, "succeeded", JSON.stringify(result));
  const owner = JSON.parse(await fs.readFile(path.join(f.base, f.job.client.slug, ".core-install-owner.json"), "utf8"));
  assert.equal(owner.state, "installed");
  assert.equal((await fs.readdir(f.units)).length, 2);
  const contents = (await Promise.all((await fs.readdir(f.units)).map((name) => fs.readFile(path.join(f.units, name), "utf8")))).join("\n");
  assert.equal(contents.includes(f.secret.clientAdminPassword), false); assert.equal(contents.includes(f.secret.databaseUrl), false);
  for (const cmd of f.commands.filter((cmd) => cmd.args.includes("ci") || cmd.args.includes("build"))) assert.equal(cmd.env?.DATABASE_URL, undefined);
  assert.equal(f.commands.find((cmd) => cmd.args.some((arg) => String(arg).endsWith("runtime-init.cjs"))).env.LMS_RUNTIME_REQUIRE_RESTRICTED_ROLE, "true");
  assert.equal(f.commands.some((cmd) => cmd.file === "systemctl" && cmd.args[0] === "stop"), false);
  const second = await executeNewInstall(f.driver); assert.equal(second.phase, "failed"); assert.equal(second.errorCode, "INSTALL_PATH_OCCUPIED");
  assert.equal((await fs.readdir(f.units)).length, 2);
  const shared = path.join(f.base, f.job.client.slug, "shared");
  const saved = openSecrets(JSON.parse(await fs.readFile(path.join(shared, "runtime-vault.json"), "utf8")), await fs.readFile(path.join(shared, "runtime-vault.key")), f.job.client.id);
  assert.equal(saved.clientAdminPassword, undefined); assert.equal(saved.systemAdminPassword, undefined);
});
test("activation failure removes only newly created unit files and keeps SQL/owned files for diagnosis", async (t) => {
  const f = await fixture(t, (file, args) => file === "systemctl" && args[0] === "enable" && args.at(-1).endsWith("-web.service"));
  const result = await executeNewInstall(f.driver); assert.equal(result.phase, "needs_attention");
  assert.deepEqual(await fs.readdir(f.units), []);
  assert.ok(await fs.stat(path.join(f.base, f.job.client.slug, ".core-install-owner.json")));
  assert.equal(f.commands.filter((cmd) => cmd.file === "systemctl" && cmd.args[0] === "disable").every((cmd) => cmd.args.at(-1).startsWith("lms-local-fixture-")), true);
});
test("modified payload is refused before any account or directory is created", async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.pkg, "backend/runtime-api.cjs"), "changed");
  await assert.rejects(verifyPackage(f.pkg, f.job.releaseId), (error) => error.code === "RELEASE_HASH_MISMATCH");
  assert.equal((await executeNewInstall(f.driver)).phase, "failed"); assert.equal(f.commands.length, 0);
});

test("source installation imports exact Git collections and verifies a persisted receipt before success", async t => {
  const f = await fixture(t, undefined, false, "source");
  assert.equal((await executeNewInstall(f.driver)).phase, "succeeded");
  const receipt = JSON.parse(await fs.readFile(path.join(f.base, f.job.client.slug, "shared/content-receipt.json"), "utf8"));
  assert.equal(receipt.mode, "source"); assert.equal(receipt.verified, true); assert.equal(receipt.topics, 1); assert.equal(receipt.tests, 1);
  assert.equal(f.runtime.get("core_lms_route_v1").data[0].title, "Git topic");
  assert.equal(f.runtime.get("core_lms_users_v1").revision, 1);
});

test("content-mode substitution and changed source summary fail before any resources are reserved", async t => {
  const f = await fixture(t, undefined, false, "source");
  f.job.contentMode = "empty";
  assert.equal((await executeNewInstall(f.driver)).errorCode, "JOB_CONTENT_MODE_MISMATCH");
  assert.equal(f.commands.length, 0);
  const file = path.join(f.pkg, "release-manifest.json"), manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.curriculum.topics = 9; await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(verifyPackage(f.pkg, f.job.releaseId), /CURRICULUM/);
});

test("lost curriculum cannot reach commit and bootstrap failure keeps the encryption recovery vault", async t => {
  const f = await fixture(t, undefined, false, "source");
  await f.driver.validate(); await f.driver.reserve(); await f.driver.build(); await f.driver.initialize(); await f.driver.bootstrap();
  await f.driver.configure(); await f.driver.activate();
  f.runtime.delete("core_lms_tests_v1");
  await assert.rejects(f.driver.health(), /INSTALL_VERIFY_FAILED/); await f.driver.cleanup();
  const g = await fixture(t, undefined, false, "source");
  g.runtime.set("core_lms_tests_v1", { key: "core_lms_tests_v1", found: true, revision: 1, data: [{ id: "own", title: "Keep" }] });
  const result = await executeNewInstall(g.driver);
  assert.equal(result.phase, "needs_attention"); assert.equal(result.failedStep, "bootstrap"); assert.equal(result.errorCode, "CURRICULUM_INSTALL_VERIFY_FAILED");
  const shared = path.join(g.base, g.job.client.slug, "shared");
  const saved = openSecrets(JSON.parse(await fs.readFile(path.join(shared, "runtime-vault.json"), "utf8")), await fs.readFile(path.join(shared, "runtime-vault.key")), g.job.client.id);
  assert.ok(saved.encryptionKey); assert.equal(saved.clientAdminPassword, undefined);
  assert.equal(g.runtime.has("core_lms_route_v1"), false);
});
test("real privileged CLI refuses Windows before touching job paths or services", () => {
  if (process.platform === "win32") assert.throws(() => execFileSync(process.execPath, [path.resolve(__dirname, "../../../infra/scripts/lms-new-install-worker.cjs")], { stdio: ["ignore", "pipe", "pipe"] }), (error) => JSON.parse(error.stderr.toString()).errorCode === "LINUX_ROOT_REQUIRED");
});
test("credential/process waits are bounded and an exited private group is never signaled again", async () => {
  const { Readable, PassThrough } = require("node:stream");
  await assert.rejects(readSecretInput(Readable.from(["x".repeat(70000)])), (error) => error.code === "SECRET_INPUT_TOO_LARGE");
  await assert.rejects(readSecretInput(new PassThrough(), 20), (error) => error.code === "SECRET_INPUT_TIMEOUT");
  const signals = [];
  await stopPrivateGroup(Promise.resolve(), (signal) => signals.push(signal), () => false, 20);
  assert.deepEqual(signals, ["SIGTERM"]);
  let ended;
  const waiting = new Promise((resolve) => { ended = resolve; });
  await stopPrivateGroup(waiting, (signal) => { signals.push(signal); if (signal === "SIGKILL") ended(); }, () => true, 5);
  assert.deepEqual(signals.slice(1), ["SIGTERM", "SIGKILL"]);
});
