const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright");
const { root, dbRequire } = require("./runtime-test-helper.cjs");
const { LocalGitPreviewService } = require("../dist/local-git-preview.js");
const { InstallationPackageService } = require("../dist/installation-package.js");
const { SourceSnapshotService } = require("../dist/source-snapshots.js");

test("explicit legacy-custom preview remains compatible, authenticates both isolated admins and cleans its database", { timeout: 650000 }, async () => {
  assert.ok(process.env.CORE_TEST_DESIGN_PACKAGES);
  const receipt = JSON.parse(await fs.readFile(process.env.CORE_TEST_DESIGN_PACKAGES, "utf8"));
  const pkg = receipt.packages[0].artifact;
  const source = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/runtime-adapted-sources", pkg.sourceId, "manifest.json"), "utf8"));
  const design = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/client-designs", pkg.design.id, "manifest.json"), "utf8"));
  const presentation = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/client-designs", pkg.design.id, "design.json"), "utf8"));
  const client = { id: pkg.design.clientId, name: "Git preview fixture", slug: "git-preview-fixture", domain: "preview.invalid", brandName: presentation.brandName, tariff: "base", industryTemplate: "coffee_shop" };
  const config = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8"));
  const postgres = dbRequire("postgres"), sql = postgres(config.environment.DATABASE_URL, { max: 1, onnotice: () => {} });
  const count = async () => (await sql`SELECT (SELECT count(*)::int FROM pg_database WHERE datname ~ '^lms_[a-f0-9]{32}$') AS databases, (SELECT count(*)::int FROM pg_roles WHERE rolname ~ '^lms_role_[a-f0-9]{32}$') AS roles`)[0];
  const before = await count(), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const originalDesign = hash(await fs.readFile(path.join(pkg.payloadPath, "lms/core-client-design.json")));
  const states = [], sources = new SourceSnapshotService(root, {}, "C:\\Windows\\System32\\tar.exe");
  const service = new LocalGitPreviewService(root, new InstallationPackageService(root, sources), { capture: async () => design }, async () => ({ client }), async () => config.environment.DATABASE_URL, (state) => states.push(state));
  const output = path.join(root, "infra/runtime/local-acceptance/git-preview-20261029", randomUUID());
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    await service.start(client.id, { id: source.snapshotId, revision: source.revision, repositoryUrl: "git@github.com:aroslavkorolkov6770-byte/tea-app.git" }, "custom");
    await assert.rejects(service.start(client.id, { id: source.snapshotId, revision: source.revision, repositoryUrl: "fixture" }), /остановите/);
    const deadline = Date.now() + 540000;
    while (!["ready", "failed"].includes(service.get().phase)) { assert.ok(Date.now() < deadline, "Git preview exceeded its deadline"); await new Promise((resolve) => setTimeout(resolve, 200)); }
    const state = service.get(); assert.equal(state.phase, "ready", JSON.stringify(state));
    assert.equal(state.revision, source.revision); assert.equal(state.clientId, client.id);
    assert.equal(JSON.stringify(states).includes("preview.admin"), false, "Credentials must not reach public state");
    browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === state.url ? route.continue() : route.abort());
    await page.goto(state.url); await page.waitForURL(/\/login/);
    await page.getByRole("heading", { name: presentation.content.loginTitle, exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "login.png"), animations: "disabled" });
    for (const role of ["admin", "system"]) {
      const cookie = await service.login(role);
      const { path: ignoredPath, ...browserCookie } = cookie;
      await page.context().clearCookies(); await page.context().addCookies([{ ...browserCookie, sameSite: "Lax" }]);
      await page.goto(state.url + "/admin");
      await page.getByRole("heading", { name: presentation.content.adminTitle, exact: true }).waitFor();
      const session = await page.evaluate(async () => (await fetch("/api/auth/session")).json());
      assert.equal(session.authenticated, true); assert.equal(session.user.systemAccount === true, role === "system");
      const materials = await page.evaluate(async () => (await fetch("/api/storage?key=tea_hub_dynamic_tests_v1")).json());
      assert.deepEqual(materials, []);
      const logout = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status);
      assert.equal(logout, 200);
    }
    assert.deepEqual(errors, []);
    assert.equal(hash(await fs.readFile(path.join(pkg.payloadPath, "lms/core-client-design.json"))), originalDesign);
    await browser.close(); browser = undefined;
    await service.stop(); assert.equal(service.get().phase, "stopped");
    await assert.rejects(service.login("system"), /дождитесь/);
    assert.deepEqual(await count(), before);
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify({ checkedAt: new Date().toISOString(), revision: source.revision, bothAdminRoles: true, emptyMaterials: true, immutablePackage: true, isolatedDatabaseCleaned: true, publicStatesWithoutCredentials: true, errors, externalActions: false, phases: states.map((state) => state.phase) }, null, 2));
    console.log(JSON.stringify({ output, phase: service.get().phase }));
  } finally { if (browser) await browser.close(); await service.stop(); await sql.end({ timeout: 5 }); }
});
