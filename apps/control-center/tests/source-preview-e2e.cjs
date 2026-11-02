const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright");
const { root, dbRequire } = require("./runtime-test-helper.cjs");
const { LocalGitPreviewService } = require("../dist/local-git-preview.js");
const { NewInstallationService } = require("../dist/new-installation.js");
const { InstallationPackageService } = require("../dist/installation-package.js");
const { SourceSnapshotService } = require("../dist/source-snapshots.js");
const { assertSourceUi } = require("../../../infra/testing/source-ui-fidelity.cjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("default preview and installation use the same unmodified Git UI, real PNG, themes and private backend", { timeout: 650000 }, async () => {
  assert.ok(process.env.CORE_TEST_LMS_SOURCE_ID);
  const source = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/runtime-adapted-sources", process.env.CORE_TEST_LMS_SOURCE_ID, "manifest.json"), "utf8"));
  const sources = new SourceSnapshotService(root, {}, "C:\\Windows\\System32\\tar.exe"), snapshot = await sources.verifySnapshot(source.snapshotId);
  const packages = new InstallationPackageService(root, sources);
  const client = { id: randomUUID(), name: "Source preview fixture", slug: "source-preview-fixture", domain: "preview.invalid", brandName: "Not a replacement for source logo", tariff: "base", industryTemplate: "coffee_shop" };
  const detail = { client, profile: { databaseHost: "127.0.0.1", databasePort: 5432 }, adminCredentials: { clientAdminLogin: "preview.admin", systemAdminLogin: "preview.system" } };
  const legacySettings = { capture: async () => { throw Error("Do not load legacy editor defaults"); }, currentHash: async () => { throw Error("Do not invalidate source UI for unused legacy settings"); }, read: async () => { throw Error("Do not read legacy design"); } };
  const plans = new NewInstallationService(root, sources, { withSession: async () => { throw Error("No SSH in this acceptance"); } }, async () => detail, packages, legacySettings);
  const target = { host: "127.0.0.1", port: 22822, username: "root", basePath: "/srv/lms-core/clients", fingerprint: "" };
  const plan = await plans.prepare(client.id, snapshot.id, target), prepared = await plans.preparePackage(client.id, plan.id);
  assert.equal(prepared.presentationMode, "source"); assert.equal(prepared.design, undefined); assert.equal(prepared.package.design, undefined);
  const pkg = prepared.package, payload = path.join(root, "infra/runtime/installation-packages", pkg.id, "payload/lms");
  const beforePackage = hash(await fs.readFile(path.dirname(payload) + "/../installation.tar"));
  const modified = new Set(source.modifiedFiles.map((entry) => entry.path));
  const matched = [];
  const compare = async (base, prefix) => {
    for (const entry of await fs.readdir(path.join(base, prefix), { withFileTypes: true })) {
      const file = prefix + "/" + entry.name;
      if (entry.isDirectory()) await compare(base, file);
      else if (!modified.has(file)) { assert.equal(hash(await fs.readFile(path.join(payload, file))), hash(await fs.readFile(path.join(base, file))), `Source UI changed: ${file}`); matched.push(file); }
    }
  };
  await compare(snapshot.sourcePath, "app"); await compare(snapshot.sourcePath, "public");
  for (const file of ["core-client-design.json", "app/components/CoreClientDesign.tsx"]) await assert.rejects(fs.stat(path.join(payload, file)), { code: "ENOENT" });
  const config = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8"));
  const sql = dbRequire("postgres")(config.environment.DATABASE_URL, { max: 1, onnotice: () => {} });
  const count = async () => (await sql`SELECT (SELECT count(*)::int FROM pg_database WHERE datname ~ '^lms_[a-f0-9]{32}$') AS databases, (SELECT count(*)::int FROM pg_roles WHERE rolname ~ '^lms_role_[a-f0-9]{32}$') AS roles`)[0];
  const before = await count(), states = [];
  const output = path.join(root, "infra/runtime/local-acceptance/source-preview-20261029", randomUUID()); await fs.mkdir(output, { recursive: true });
  const service = new LocalGitPreviewService(root, { prepare: async (id, design) => { assert.equal(id, snapshot.id); assert.equal(design, undefined); return pkg; }, verify: (value, id) => packages.verify(value, id) }, legacySettings, async () => detail, async () => config.environment.DATABASE_URL, (state) => states.push(state));
  let browser;
  try {
    await service.start(client.id, snapshot);
    const deadline = Date.now() + 540000;
    while (!["ready", "failed"].includes(service.get().phase)) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 200)); }
    const state = service.get(); assert.equal(state.phase, "ready", JSON.stringify(state)); assert.equal(state.presentationMode, "source");
    const health = await (await fetch(state.url + "/api/core-runtime/health")).json(); assert.equal(health.releaseId, pkg.id);
    const logo = await fetch(state.url + "/vates-logo-transparent.png"); assert.equal(logo.status, 200);
    assert.equal(hash(Buffer.from(await logo.arrayBuffer())), hash(await fs.readFile(path.join(snapshot.sourcePath, "public/vates-logo-transparent.png"))));
    browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === state.url ? route.continue() : route.abort());
    const visual = await assertSourceUi(page, state.url, output);
    await page.setViewportSize({ width: 1440, height: 950 });
    for (const role of ["admin", "system"]) {
      const { path: ignoredPath, ...cookie } = await service.login(role);
      await page.context().clearCookies(); await page.context().addCookies([{ ...cookie, sameSite: "Lax" }]);
      await page.goto(state.url + "/admin"); await page.getByRole("heading", { name: "Рабочее пространство", exact: true }).waitFor();
      assert.equal(await page.locator(".core-client-brand,style[data-core-design-style]").count(), 0);
      const session = await page.evaluate(async () => (await fetch("/api/auth/session")).json());
      assert.equal(session.authenticated, true); assert.equal(session.user.systemAccount === true, role === "system");
      await page.goto(state.url + "/profile"); await page.getByRole("heading", { name: "Мой профиль", exact: true }).first().waitFor();
      await page.goto(state.url + "/tasks?tab=edu"); await page.locator(".vates-education-screen").waitFor();
      for (const key of ["tea_hub_dynamic_route_v2", "tea_hub_dynamic_tests_v1"]) assert.deepEqual(await page.evaluate(async (key) => (await fetch("/api/storage?key=" + key)).json(), key), []);
      await page.screenshot({ path: path.join(output, `${role}-empty-learning.png`), animations: "disabled" });
      assert.equal(await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status), 200);
      assert.equal(await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).authenticated), false);
    }
    assert.deepEqual(errors, []);
    await browser.close(); browser = undefined; await service.stop(); assert.equal(service.get().phase, "stopped");
    assert.deepEqual(await count(), before);
    assert.equal(hash(await fs.readFile(path.dirname(payload) + "/../installation.tar")), beforePackage);
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify({ checkedAt: new Date().toISOString(), revision: source.revision, sourceId: source.id, package: pkg, payload, matchedSourceFiles: matched, visual, bothAdmins: true, emptyMaterials: true, logout: true, privateBackend: true, immutablePackage: true, cleanup: true, externalActions: false, errors }, null, 2));
    console.log(JSON.stringify({ output, sourceUiFiles: matched.length, packageId: pkg.id, bothAdmins: true, visualStates: visual.states.length, phase: service.get().phase }));
  } finally { if (browser) await browser.close(); await service.stop(); await sql.end({ timeout: 5 }); }
});
