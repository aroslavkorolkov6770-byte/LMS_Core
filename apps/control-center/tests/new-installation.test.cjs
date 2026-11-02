const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { NewInstallationService, normalizeInstallationProfile, newInstallationPaths, inspectInstallationSource, parseNewServerPreflight, installationChecks } = require("../dist/new-installation.js");
const clientId = "b89cc922-c63e-448c-bbe5-f696a5197948";
const snapshotId = "f0140c68-d136-4fe2-aa40-80d9ae2e5185";
const target = { host: "fixture.example", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/var/www/existing-app", fingerprint: "SHA256:" + "A".repeat(43) };
const detail = () => ({ client: { id: clientId, name: "Клиент <img src=x>", slug: "client-one", domain: "fixture.example", brandName: "Fixture", tariff: "base", industryTemplate: "coffee_shop" },
  profile: { databaseHost: "db.fixture.example", databasePort: 5432, databaseName: "client_one", databaseUser: "client_one", databasePasswordSecretRef: "vault:fixture-private-reference", password: "fixture-private-password" },
  adminCredentials: { clientAdminLogin: "admin@fixture.example", systemAdminLogin: "system@fixture.example", password: "fixture-private-password" }, password: "fixture-private-password" });

const serverOutput = (appPath, extra = {}) => Object.entries({ protocol: "lms-new-install-v1", kernel: "Linux", os: "Ubuntu fixture", username: "root", uid: 0,
  appPath, pathState: "available", writable: 1, node: "v22.fixture", npm: "12.fixture", pm2: "", systemd: 1, apiPort: 4101, ssAvailable: 1, candidatePort: 3001,
  freeDiskBytes: 10 * 1024 ** 3, memoryBytes: 1024 ** 3, swapBytes: 4 * 1024 ** 3, ...extra }).map(([key, value]) => `${key}\t${value}`).join("\n");

test("nominal 1 GB VPS accepts reserved kernel memory but still requires the complete build budget", async (t) => {
  const f = await fixture(t), plan = await f.service.prepare(clientId, snapshotId, target);
  const check = (memoryBytes, swapBytes) => installationChecks({ ...plan, preflight: parseNewServerPreflight(serverOutput(plan.paths.root, { memoryBytes, swapBytes }), plan.paths.root) }).find((item) => item.code === "MEMORY");
  assert.equal(check(1007828992, 4 * 1024 ** 3).status, "passed");
  assert.equal(check(1007828992, 536866816).status, "blocked");
  assert.match(check(1007828992, 536866816).message, /961 МиБ.*0\.50 ГиБ.*1\.44 ГиБ/);
  assert.equal(check(899 * 1024 ** 2, 4 * 1024 ** 3).status, "blocked");
  assert.equal(check(900 * 1024 ** 2, 3 * 1024 ** 3 - 900 * 1024 ** 2).status, "passed");
});

async function fixture(t, withPackage = false, withDesign = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-new-install-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("core-new-install-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const sourcePath = path.join(root, "source");
  await fs.mkdir(path.join(sourcePath, "app/lib/database"), { recursive: true });
  await fs.writeFile(path.join(sourcePath, "app/lib/database/config.ts"), "export type DataBackend = 'json' | 'mysql';");
  await fs.writeFile(path.join(sourcePath, "app/lib/serverAuth.ts"), "const a=process.env.BOOTSTRAP_ADMIN_LOGIN; const b=process.env.BOOTSTRAP_ADMIN_PASSWORD; /* fixture-private-password */");
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts/lms-new-install-preflight.sh"), path.join(root, "infra/scripts/lms-new-install-preflight.sh"));
  const snapshot = { id: snapshotId, sourcePath, revision: "a".repeat(40), archiveSha256: "b".repeat(64), repositoryUrl: "git@github.com:fixture/lms.git", branch: "main", requestedBranch: "" };
  const calls = [];
  const profile = detail();
  const remote = { withSession: async (selected, auth, operation) => {
    calls.push({ selected, auth: auth.mode });
    assert.equal(auth.password, "fixture-private-password");
    return operation({ execute: async (command, script) => {
      assert.equal(command, "sh -s");
      assert.ok(script.includes("/srv/lms-core/clients/client-one"));
      assert.ok(!script.includes("fixture-private-password"));
      return serverOutput(selected.appPath);
    } });
  } };
  const packageValue = { id: "a23ef431-a048-4819-afb4-121414f6e385", sourceId: "9bc89c2b-75a8-4931-8776-7484a871804d", revision: snapshot.revision, sha256: "c".repeat(64), archiveBytes: 1000 };
  const packageState = { valid: true };
  const packages = { prepare: async () => packageValue, verify: async () => { if (!packageState.valid) throw Error("changed"); return { ...packageValue, archivePath: "fixture" }; } };
  const designState = { sha256: "d".repeat(64) };
  const reference = { id: "a23ef431-a048-4819-afb4-121414f6e385", version: 1, clientId, sha256: designState.sha256, source: "saved" };
  if (withDesign) packageValue.design = { ...reference, supportedTextKeys: ["homeTitle"] };
  const designs = withDesign ? { capture: async () => ({ ...reference }), currentHash: async () => designState.sha256, read: async () => ({}) } : undefined;
  const service = new NewInstallationService(root, { verifySnapshot: async (id) => { assert.equal(id, snapshotId); return snapshot; } }, remote, async (id) => { assert.equal(id, clientId); return profile; }, withPackage ? packages : undefined, designs);
  return { root, service, calls, profile, snapshot, packageState, designState, designs, packageValue, packages };
}

test("content choice is frozen into a plan; changing it cannot reuse the other policy archive", async t => {
  const f = await fixture(t, true);
  f.packages.prepare = async (_snapshot, _design, mode) => ({ ...f.packageValue, contentMode: mode,
    ...(mode === "source" ? { curriculum: { revision: f.snapshot.revision, sha256: "d".repeat(64), topics: 25, tests: 9, questions: 89 } } : {}) });
  f.packages.verify = async value => ({ ...value, archivePath: "fixture" });
  const plan = await f.service.prepare(clientId, snapshotId, target, "source", "source");
  const built = await f.service.preparePackage(clientId, plan.id);
  assert.equal(built.contentMode, "source"); assert.equal(built.package.curriculum.topics, 25);
  assert.match(built.checks.find(check => check.code === "CONTENT_POLICY").message, /25/);
  const same = await f.service.prepare(clientId, snapshotId, target, "source", "source");
  assert.deepEqual(same.package, built.package);
  const empty = await f.service.prepare(clientId, snapshotId, target, "source", "empty");
  assert.equal(empty.package, undefined);
  const emptyBuilt = await f.service.preparePackage(clientId, empty.id);
  assert.equal(emptyBuilt.package.contentMode, "empty"); assert.equal(emptyBuilt.package.curriculum, undefined);
  const file = path.join(f.root, "infra/runtime/new-installations", clientId + ".json"), saved = JSON.parse(await fs.readFile(file, "utf8"));
  delete saved.contentMode; await fs.writeFile(file, JSON.stringify(saved));
  const legacy = await f.service.get(clientId);
  assert.equal(legacy.contentMode, undefined); assert.equal(legacy.checks.find(check => check.code === "CONTENT_POLICY").status, "blocked");
  await assert.rejects(f.service.preparePackage(clientId, empty.id), /наполнение/i);
});

test("refreshing only the server check preserves the existing plan and installation package", async (t) => {
  const f = await fixture(t, true);
  const plan = await f.service.prepare(clientId, snapshotId, target);
  await f.service.preparePackage(clientId, plan.id);
  const ready = await f.service.checkServer(clientId, plan.id, target, { mode: "password", password: "fixture-private-password" });
  const file = path.join(f.root, "infra/runtime/new-installations", clientId + ".json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.preflight.checkedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await fs.writeFile(file, JSON.stringify(saved));
  const refreshed = await f.service.checkServer(clientId, plan.id, target, { mode: "password", password: "fixture-private-password" });
  assert.equal(refreshed.id, ready.id);
  assert.deepEqual(refreshed.package, ready.package);
  assert.deepEqual(refreshed.source, ready.source);
  assert.deepEqual(refreshed.target, ready.target);
  assert.equal(refreshed.createdAt, ready.createdAt);
  assert.notEqual(refreshed.preflight.checkedAt, saved.preflight.checkedAt);
  assert.equal(refreshed.status, "prepared");
  assert.equal(f.calls.length, 2);
});

test("all client configuration changes are rejected before package build and SSH; irrelevant metadata is ignored", async t => {
  const f = await fixture(t, true), plan = await f.service.prepare(clientId, snapshotId, target);
  const original = structuredClone(f.profile.client); let builds = 0;
  const prepare = f.packages.prepare; f.packages.prepare = async (...args) => { builds++; return prepare(...args); };
  const changes = { name: "New name", brandName: "New brand", tariff: "extended", industryTemplate: "retail_store", domain: "another.example", includedUsers: 15, maxAdmins: 3, aiRequestsLimit: 777, primaryColor: "#123456" };
  for (const [key, value] of Object.entries(changes)) {
    f.profile.client = { ...original, [key]: value };
    await assert.rejects(f.service.preparePackage(clientId, plan.id), /Карточка клиента изменилась/);
    await assert.rejects(f.service.checkServer(clientId, plan.id, target, { mode: "password", password: "fixture-private-password" }), /Карточка клиента изменилась/);
  }
  f.profile.client = { ...original, notes: "Not a deployment field", updatedAt: "changed", apiKey: "fixture-private-password", domain: "HTTPS://FIXTURE.EXAMPLE/" };
  assert.doesNotThrow(() => f.service.assertProfileCurrent(plan, f.profile));
  for (const change of [() => { f.profile.adminCredentials.clientAdminLogin = "new.admin"; }, () => { f.profile.adminCredentials.systemAdminLogin = "new.system"; }]) {
    const admins = { ...f.profile.adminCredentials }; change();
    await assert.rejects(f.service.preparePackage(clientId, plan.id), /логины администраторов/);
    f.profile.adminCredentials = admins;
  }
  assert.equal(builds, 0); assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(plan.clientConfiguration).includes("fixture-private"));
});

test("new plan reuses immutable code after a card or host change, but never the previous server check", async t => {
  const f = await fixture(t, true), first = await f.service.prepare(clientId, snapshotId, target);
  const built = await f.service.preparePackage(clientId, first.id);
  await f.service.checkServer(clientId, first.id, target, { mode: "password", password: "fixture-private-password" });
  f.profile.client.brandName = "New brand";
  const next = await f.service.prepare(clientId, snapshotId, { ...target, host: "new.fixture.example" });
  assert.notEqual(next.id, first.id); assert.deepEqual(next.package, built.package); assert.equal(next.preflight, null);
  assert.equal(next.target.host, "new.fixture.example"); assert.notEqual(next.clientConfiguration.sha256, first.clientConfiguration.sha256);
  assert.doesNotThrow(() => f.service.assertProfileCurrent(next, f.profile));
});

test("legacy plan is visibly blocked without inventing a snapshot; a fresh plan may retain its verified code", async t => {
  const f = await fixture(t, true), plan = await f.service.prepare(clientId, snapshotId, target);
  const built = await f.service.preparePackage(clientId, plan.id);
  const file = path.join(f.root, "infra/runtime/new-installations", clientId + ".json"), saved = JSON.parse(await fs.readFile(file, "utf8"));
  delete saved.clientConfiguration; await fs.writeFile(file, JSON.stringify(saved));
  const before = await fs.readFile(file, "utf8"), legacy = await f.service.get(clientId);
  assert.equal(legacy.clientConfiguration, undefined); assert.equal(legacy.status, "blocked");
  assert.equal(legacy.checks.find(v => v.code === "CLIENT_CONFIGURATION").status, "blocked");
  await assert.rejects(f.service.preparePackage(clientId, plan.id), /полного снимка/);
  assert.equal(await fs.readFile(file, "utf8"), before);
  const next = await f.service.prepare(clientId, snapshotId, target);
  assert.deepEqual(next.package, built.package); assert.ok(next.clientConfiguration); assert.equal(next.preflight, null);
});

test("changed source or rejected archive is not carried into the new plan", async t => {
  const f = await fixture(t, true), first = await f.service.prepare(clientId, snapshotId, target);
  await f.service.preparePackage(clientId, first.id);
  f.snapshot.revision = "e".repeat(40);
  assert.equal((await f.service.prepare(clientId, snapshotId, target)).package, undefined);
  f.snapshot.revision = "a".repeat(40);
  const another = await f.service.prepare(clientId, snapshotId, target); await f.service.preparePackage(clientId, another.id);
  f.packageState.valid = false;
  assert.equal((await f.service.prepare(clientId, snapshotId, target)).package, undefined);
});

test("explicit point document enters the plan/package and a later save blocks the frozen plan before SSH", async (t) => {
  const f = await fixture(t, true);
  const reference = { id: "a23ef431-a048-4819-afb4-121414f6e385", version: 3, clientId, sha256: "d".repeat(64), source: "saved" };
  let current = reference.sha256;
  const points = { captureOptional: async () => reference, currentHash: async () => current, hasChanges: async () => true };
  const packages = { ...f.packages, prepare: async (_source, ref) => ({ ...f.packageValue, design: { ...ref, supportedTextKeys: [] } }), verify: async (value) => ({ ...value, archivePath: "fixture" }) };
  const service = new NewInstallationService(f.root, { verifySnapshot: async () => f.snapshot }, { withSession: async () => { throw Error("SSH must not begin"); } }, async () => f.profile, packages,
    { read: async () => ({}), capture: async () => { throw Error("Legacy defaults are not point edits"); }, currentHash: async () => { throw Error("No legacy settings"); } }, points);
  const plan = await service.prepare(clientId, snapshotId, target);
  assert.equal(plan.presentationMode, "point"); assert.equal(plan.design.version, 3);
  const prepared = await service.preparePackage(clientId, plan.id);
  assert.equal(prepared.checks.find((check) => check.code === "PRESENTATION").status, "passed");
  assert.equal(prepared.package.design.sha256, reference.sha256);
  current = "e".repeat(64);
  assert.equal((await service.get(clientId)).checks.find((check) => check.code === "PRESENTATION").status, "blocked");
  await assert.rejects(service.preparePackage(clientId, plan.id), /Пересоздайте/);
});

test("saving the first point edit invalidates a previously source-only plan without changing it on disk", async (t) => {
  const f = await fixture(t, true); let changed = false;
  const service = new NewInstallationService(f.root, { verifySnapshot: async () => f.snapshot }, {}, async () => f.profile, f.packages, undefined,
    { captureOptional: async () => undefined, currentHash: async () => "d".repeat(64), hasChanges: async () => changed });
  const plan = await service.prepare(clientId, snapshotId, target);
  const file = path.join(f.root, "infra/runtime/new-installations", clientId + ".json"), original = await fs.readFile(file, "utf8");
  assert.equal(plan.presentationMode, "source"); changed = true;
  assert.equal((await service.get(clientId)).checks.find((check) => check.code === "PRESENTATION").status, "blocked");
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("saved design is bound to a plan; later editor saves block package and SSH check", async (t) => {
  const f = await fixture(t, true, true);
  const plan = await f.service.prepare(clientId, snapshotId, target, "custom");
  assert.equal(plan.design.sha256, f.designState.sha256);
  const packaged = await f.service.preparePackage(clientId, plan.id);
  assert.equal(packaged.checks.find((check) => check.code === "DESIGN").status, "passed");
  f.designState.sha256 = "e".repeat(64);
  await assert.rejects(f.service.preparePackage(clientId, plan.id), /оформление изменилось/);
  await assert.rejects(f.service.checkServer(clientId, plan.id, target, { mode: "password", password: "fixture-private-password" }), /оформление изменилось/);
  assert.equal(f.calls.length, 0);
});

test("source mode never reads legacy design settings and packages the original UI by default", async (t) => {
  const f = await fixture(t, true, true);
  delete f.packageValue.design;
  f.designs.capture = f.designs.currentHash = f.designs.read = async () => { throw Error("Legacy design must stay untouched"); };
  const plan = await f.service.prepare(clientId, snapshotId, target);
  assert.equal(plan.presentationMode, "source"); assert.equal(plan.designRequired, false); assert.equal(plan.design, undefined);
  const packaged = await f.service.preparePackage(clientId, plan.id);
  assert.equal(packaged.package.design, undefined);
  const ready = await f.service.checkServer(clientId, plan.id, target, { mode: "password", password: "fixture-private-password" });
  assert.equal(ready.status, "prepared"); assert.equal((await f.service.get(clientId)).presentationMode, "source");
});

test("old implicit design plans remain on disk but cannot silently deploy or be checked", async (t) => {
  const f = await fixture(t, true, true);
  const plan = await f.service.prepare(clientId, snapshotId, target, "custom");
  await f.service.preparePackage(clientId, plan.id);
  await f.service.checkServer(clientId, plan.id, target, { mode: "password", password: "fixture-private-password" });
  const file = path.join(f.root, "infra/runtime/new-installations", clientId + ".json");
  // Simulate an on-disk plan from before presentation mode became explicit.
  const saved = JSON.parse(await fs.readFile(file, "utf8")); delete saved.presentationMode;
  await fs.writeFile(file, JSON.stringify(saved));
  const before = await fs.readFile(file, "utf8"), calls = f.calls.length;
  const legacy = await f.service.get(clientId);
  assert.equal(legacy.presentationReviewRequired, true); assert.equal(legacy.status, "blocked");
  await assert.rejects(f.service.preparePackage(clientId, plan.id), /Пересоздайте план/);
  await assert.rejects(f.service.checkServer(clientId, plan.id, target, { mode: "password", password: "fixture-private-password" }), /Пересоздайте план/);
  assert.equal(f.calls.length, calls); assert.equal(await fs.readFile(file, "utf8"), before);
});

test("a personalized package cannot be substituted into a source-mode plan", async (t) => {
  const f = await fixture(t, true, true);
  const plan = await f.service.prepare(clientId, snapshotId, target);
  await assert.rejects(f.service.preparePackage(clientId, plan.id), /Пакет содержит оформление/);
  assert.equal((await f.service.get(clientId)).package, undefined);
});

test("new path and process use the selected client, never the existing update path", async (t) => {
  const f = await fixture(t);
  const plan = await f.service.prepare(clientId, snapshotId, target);
  assert.equal(plan.kind, "new_installation");
  assert.equal(plan.paths.root, "/srv/lms-core/clients/client-one");
  assert.equal(plan.paths.current, "/srv/lms-core/clients/client-one/current");
  assert.equal(plan.target.appPath, plan.paths.root);
  assert.equal(plan.processName, "lms-client-one");
  assert.equal(plan.database.engine, "postgresql");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(plan.source.databaseBackends, ["json", "mysql"]);
  assert.equal(plan.source.bootstrapAdminFromEnvironment, true);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.checks.find((check) => check.code === "POSTGRES_ADAPTER").status, "blocked");
});

test("accepted package and real systemd preflight prepare a NEW job without PM2; stale package locks it again", async (t) => {
  const f = await fixture(t, true);
  const plan = await f.service.prepare(clientId, snapshotId, target);
  const packaged = await f.service.preparePackage(clientId, plan.id);
  assert.equal(packaged.checks.find((check) => check.code === "POSTGRES_ADAPTER").status, "passed");
  const ready = await f.service.checkServer(clientId, plan.id, target, { mode: "password", password: "fixture-private-password" });
  assert.equal(ready.preflight.pm2, ""); assert.equal(ready.preflight.systemd, true);
  assert.equal(ready.status, "prepared"); assert.equal((await f.service.get(clientId)).status, "prepared");
  f.packageState.valid = false;
  const stale = await f.service.get(clientId);
  assert.equal(stale.package, undefined); assert.equal(stale.status, "blocked");
});

test("public plan keeps no source credentials, API secrets, secret reference values or password hashes", async (t) => {
  const f = await fixture(t);
  await f.service.prepare(clientId, snapshotId, { ...target, password: "fixture-private-password", privateKey: "fixture-private-password" });
  const file = path.join(f.root, "infra/runtime/new-installations", `${clientId}.json`);
  const text = await fs.readFile(file, "utf8");
  assert.ok(!text.includes("fixture-private-password"));
  assert.ok(!text.includes("fixture-private-reference"));
  const stored = JSON.parse(text);
  stored.password = "fixture-private-password";
  stored.target.password = "fixture-private-password";
  stored.source.privateKey = "fixture-private-password";
  await fs.writeFile(file, JSON.stringify(stored));
  assert.ok(!JSON.stringify(await f.service.get(clientId)).includes("fixture-private-password"));
});

test("read-only server check binds exact plan/client/target and clears one-time credentials", async (t) => {
  const f = await fixture(t);
  const plan = await f.service.prepare(clientId, snapshotId, target);
  const credentials = { mode: "password", password: "fixture-private-password" };
  const result = await f.service.checkServer(clientId, plan.id, target, credentials);
  assert.equal(result.preflight.candidatePort, 3001);
  assert.equal(result.checks.find((check) => check.code === "NEW_PATH").status, "passed");
  assert.equal(result.status, "blocked", "A good server does not bypass the missing PostgreSQL adapter");
  assert.equal(credentials.password, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.get(clientId)).preflight.candidatePort, 3001);
});

test("changed target, profile, source or plan ID is refused before any connection", async (t) => {
  const f = await fixture(t);
  const plan = await f.service.prepare(clientId, snapshotId, target);
  const auth = () => ({ mode: "password", password: "fixture-private-password" });
  for (const input of [{ ...target, host: "other.example" }, { ...target, username: "other" }, { ...target, basePath: "/srv/other/clients" }, { ...target, fingerprint: "SHA256:" + "B".repeat(43) }]) {
    await assert.rejects(f.service.checkServer(clientId, plan.id, input, auth()), /SSH-параметры изменены/);
  }
  await assert.rejects(f.service.checkServer(clientId, snapshotId, target, auth()), /План устарел/);
  f.profile.profile.databaseName = "changed_database";
  await assert.rejects(f.service.checkServer(clientId, plan.id, target, auth()), /Карточка клиента изменилась/);
  f.profile.profile.databaseName = "client_one";
  f.snapshot.revision = "c".repeat(40);
  await assert.rejects(f.service.checkServer(clientId, plan.id, target, auth()), /Git-версия плана изменилась/);
  assert.equal(f.calls.length, 0);
});

test("new preparation invalidates historical server result and creates a new immutable plan identity", async (t) => {
  const f = await fixture(t);
  const first = await f.service.prepare(clientId, snapshotId, target);
  await f.service.checkServer(clientId, first.id, target, { mode: "password", password: "fixture-private-password" });
  const next = await f.service.prepare(clientId, snapshotId, { ...target, host: "new.example" });
  assert.notEqual(next.id, first.id);
  assert.equal(next.preflight, null);
  assert.equal(next.target.host, "new.example");
});

test("validates client identity, slug, path and database parameters without fabricating defaults", () => {
  assert.equal(normalizeInstallationProfile(detail(), clientId).client.slug, "client-one");
  for (const change of [{ slug: "../other" }, { slug: "client;id" }, { slug: "Client" }, { id: snapshotId }]) {
    assert.throws(() => normalizeInstallationProfile({ ...detail(), client: { ...detail().client, ...change } }, clientId));
  }
  for (const change of [{ databaseHost: "postgres://user:secret@db" }, { databasePort: 0 }, { databaseName: "x;DROP" }, { databaseUser: "x--y" }]) {
    assert.throws(() => normalizeInstallationProfile({ ...detail(), profile: { ...detail().profile, ...change } }, clientId));
  }
  assert.throws(() => newInstallationPaths("/srv/../etc", "client-one"));
  assert.throws(() => newInstallationPaths("/srv/lms-core/clients", "../etc"));
});

test("static source inspection never imports a project or implies PostgreSQL compatibility from mysql2", () => {
  assert.deepEqual(inspectInstallationSource("export type DataBackend = 'json' | 'mysql';", "throw new Error('must never execute')"), { databaseBackends: ["json", "mysql"], bootstrapAdminFromEnvironment: false });
  assert.deepEqual(inspectInstallationSource("unknown", ""), { databaseBackends: [], bootstrapAdminFromEnvironment: false });
});

test("parser refuses wrong path/platform, duplicated protocol and unconfirmed free port", () => {
  const expected = "/srv/lms-core/clients/client-one";
  assert.equal(parseNewServerPreflight(serverOutput(expected), expected).candidatePort, 3001);
  for (const extra of [{ appPath: "/var/www/existing-app" }, { kernel: "other" }, { candidatePort: 22 }, { ssAvailable: 0, candidatePort: 3001 }, { freeDiskBytes: -1 }]) {
    assert.throws(() => parseNewServerPreflight(serverOutput(expected, extra), expected));
  }
  assert.throws(() => parseNewServerPreflight(serverOutput(expected) + "\nprotocol\tlms-new-install-v1", expected));
});

test("occupied path and malformed saved plan never turn into a ready installation", async (t) => {
  const f = await fixture(t);
  const plan = await f.service.prepare(clientId, snapshotId, target);
  const file = path.join(f.root, "infra/runtime/new-installations", `${clientId}.json`);
  plan.preflight = parseNewServerPreflight(serverOutput(plan.paths.root, { pathState: "occupied", writable: 0 }), plan.paths.root);
  await fs.writeFile(file, JSON.stringify(plan));
  assert.equal((await f.service.get(clientId)).checks.find((check) => check.code === "NEW_PATH").status, "blocked");
  plan.target.appPath = "/var/www/existing-app";
  await fs.writeFile(file, JSON.stringify(plan));
  assert.equal(await f.service.get(clientId), null);
  assert.equal(await f.service.get("../../escape"), null);
});
