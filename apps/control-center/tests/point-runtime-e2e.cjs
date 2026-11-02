const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright");
const { root } = require("./runtime-test-helper.cjs");
const { pointFixture } = require("./point-fixture-helper.cjs");
const { LocalGitPreviewService } = require("../dist/local-git-preview.js");
const { PointEditor } = require("../dist/point-design.js");
const { ClientDesignService } = require("../dist/client-design.js");
const { NewInstallationService } = require("../dist/new-installation.js");
const { InstallationPackageService } = require("../dist/installation-package.js");
const { SourceSnapshotService } = require("../dist/source-snapshots.js");
const { CATALOG, FONTS } = require("../../../infra/scripts/point-design-contract.cjs");
const { createPointRuntime } = require("../../../infra/lms-adapter/point-editor-preload.cjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("point editor live source preview equals installed production payload, without changing untouched Git UI", { timeout: 1100000 }, async (t) => {
  const f = await pointFixture(t);
  const adapted = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/runtime-adapted-sources", process.env.CORE_TEST_LMS_SOURCE_ID, "manifest.json"), "utf8"));
  const sources = new SourceSnapshotService(root, {}, "C:\\Windows\\System32\\tar.exe"), snapshot = await sources.verifySnapshot(adapted.snapshotId);
  const packages = new InstallationPackageService(root, sources), designs = new ClientDesignService(root, async () => { throw Error("No legacy settings"); }, async () => { throw Error("No legacy settings"); });
  const detail = { client: f.client, profile: { databaseHost: "127.0.0.1", databasePort: 5432 }, adminCredentials: { clientAdminLogin: "preview.admin", systemAdminLogin: "preview.system" } };
  const remote = { withSession: async () => { throw Error("External SSH is not part of this acceptance"); } };
  const plans = new NewInstallationService(root, sources, remote, async () => detail, packages, designs, f.service);
  const target = { host: "127.0.0.1", port: 22822, username: "root", basePath: "/srv/lms-core/clients", fingerprint: "" };
  const before = await plans.prepare(f.client.id, snapshot.id, target);
  assert.equal(before.presentationMode, "source");
  const config = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8"));
  const output = path.join(root, "infra/runtime/local-acceptance/point-editor-20261029", randomUUID());
  await fs.mkdir(output, { recursive: true });
  const sourcePreview = new LocalGitPreviewService(root, packages, designs, async () => detail, async () => config.environment.DATABASE_URL);
  let installedPreview, browser;
  const errors = [], seenElements = new Set();
  const checkElements = async (page, required = []) => {
    const ids = await page.evaluate((catalog) => catalog.filter((item) => item.route === location.pathname && [...document.querySelectorAll(item.selector)].some((element) => item.text === null || element.textContent.trim().replace(/\s+/g, " ") === item.text)).map((item) => item.id), CATALOG);
    for (const id of ids) seenElements.add(id);
    for (const id of required) assert.ok(ids.includes(id), `Expected existing editable element: ${id}`);
  };
  const waitReady = async (service) => {
    const deadline = Date.now() + 540000;
    while (!["ready", "failed"].includes(service.get().phase)) { assert.ok(Date.now() < deadline, "Production build deadline"); await new Promise((resolve) => setTimeout(resolve, 250)); }
    assert.equal(service.get().phase, "ready", JSON.stringify(service.get())); return service.get();
  };
  const newPage = async (origin) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + "/login");
    await page.locator(".login-card-heading > h1").waitFor();
    const cookie = page.getByRole("button", { name: "Только на сеанс", exact: true });
    try { await cookie.waitFor({ state: "visible", timeout: 3000 }); await cookie.click(); }
    catch (error) { if (error.name !== "TimeoutError") throw error; }
    return page;
  };
  const inspect = async (page) => page.evaluate(() => {
    const values = (selector) => { const e = document.querySelector(selector), s = getComputedStyle(e); return { text: e.textContent.trim(), color: s.color, background: s.backgroundColor, font: s.fontFamily, size: s.fontSize, radius: s.borderRadius }; };
    const logo = document.querySelector(".vates-auth-logo img, img.vates-auth-logo");
    return { title: values(".login-card-heading > h1"), button: values("button.hover-unified-auth"), untouched: values(".vates-auth-message > h1"), body: getComputedStyle(document.body).backgroundColor, logoLoaded: !!logo && logo.complete && logo.naturalWidth > 0, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  try {
    await sourcePreview.start(f.client.id, snapshot); const sourceState = await waitReady(sourcePreview);
    browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
    const page = await newPage(sourceState.url);
    await checkElements(page, ["login.story", "login.storyTitle", "login.storyDescription", "login.card", "login.title", "login.description", "login.submit"]);
    const baseline = new Map();
    for (const width of [1440, 393]) {
      await page.setViewportSize({ width, height: width === 393 ? 852 : 950 });
      for (const theme of ["light", "dark"]) { await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme); await page.waitForTimeout(300); baseline.set(`${width}:${theme}`, await inspect(page)); }
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    const editor = new PointEditor(f.service); await editor.bind(f.client.id, snapshot.revision); editor.enable(true);
    await page.evaluate(`window.pointRuntime = (${createPointRuntime.toString()})(window, ${JSON.stringify(CATALOG)}, ${JSON.stringify(editor.get().document)}, selection => { window.pointSelection = selection; }); window.pointRuntime.enable(true);`);
    await page.locator(".login-card-heading > h1").click();
    editor.select(await page.evaluate(() => window.pointSelection));
    assert.equal(editor.get().selectedId, "login.title");
    editor.change("login.title", { text: "Добро пожаловать", styles: { light: { color: "#214d56", fontFamily: FONTS.editorial, fontSizePx: 30 }, dark: { color: "#c2e6e4" } } });
    editor.change("login.submit", { text: "Войти в кабинет", styles: { light: { backgroundColor: "#214d56", color: "#ffffff", fontFamily: FONTS.humanist, fontSizePx: 16 } } });
    await page.evaluate((document) => window.pointRuntime.update(document), editor.get().document);
    await page.getByRole("heading", { name: "Добро пожаловать", exact: true }).waitFor();
    const expected = [];
    for (const width of [1440, 393]) {
      await page.setViewportSize({ width, height: width === 393 ? 852 : 950 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await page.waitForTimeout(300);
        const observed = await inspect(page), original = baseline.get(`${width}:${theme}`);
        assert.equal(observed.logoLoaded, true); assert.equal(observed.overflow, false); assert.equal(observed.button.radius, original.button.radius);
        assert.deepEqual(observed.untouched, original.untouched); assert.equal(observed.body, original.body);
        expected.push({ width, theme, observed });
        await page.screenshot({ path: path.join(output, `preview-${width}-${theme}.png`), animations: "disabled" });
      }
    }
    await editor.save(); assert.equal(editor.get().dirty, false);
    assert.equal((await plans.get(f.client.id)).status, "blocked");
    await sourcePreview.stop(); assert.equal(sourcePreview.get().phase, "stopped"); await page.close();
    const plan = await plans.prepare(f.client.id, snapshot.id, target), prepared = await plans.preparePackage(f.client.id, plan.id);
    assert.equal(prepared.presentationMode, "point"); assert.equal(prepared.design.version, 3); assert.equal(prepared.package.design.sha256, prepared.design.sha256);
    const pkg = prepared.package, payload = path.join(root, "infra/runtime/installation-packages", pkg.id, "payload/lms");
    const unchanged = ["app/login/page.tsx", "app/globals.css", "app/components/VatesLogo.tsx", "public/vates-logo-transparent.png"];
    for (const file of unchanged) assert.equal(hash(await fs.readFile(path.join(payload, file))), hash(await fs.readFile(path.join(snapshot.sourcePath, file))));
    await assert.rejects(fs.stat(path.join(payload, "app/components/CoreClientDesign.tsx")), { code: "ENOENT" });
    const frozen = hash(await fs.readFile(path.join(path.dirname(payload), "../installation.tar")));
    installedPreview = new LocalGitPreviewService(root, { prepare: async () => pkg, verify: (value, id) => packages.verify(value, id) }, { capture: async () => prepared.design }, async () => detail, async () => config.environment.DATABASE_URL);
    await installedPreview.start(f.client.id, snapshot, "custom"); const installed = await waitReady(installedPreview);
    const installedPage = await newPage(installed.url);
    await installedPage.getByRole("heading", { name: "Добро пожаловать", exact: true }).waitFor();
    for (const { width, theme, observed } of expected) {
      await installedPage.setViewportSize({ width, height: width === 393 ? 852 : 950 });
      await installedPage.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await installedPage.waitForTimeout(300);
      assert.deepEqual(await inspect(installedPage), observed);
      await installedPage.screenshot({ path: path.join(output, `installed-${width}-${theme}.png`), animations: "disabled" });
    }
    await installedPage.setViewportSize({ width: 1440, height: 950 });
    await installedPage.getByText("Пройти регистрацию", { exact: true }).click();
    await installedPage.getByRole("heading", { name: "Активация аккаунта", exact: true }).waitFor();
    await checkElements(installedPage, ["register.title", "register.description", "register.submit"]);
    assert.equal(await installedPage.getByRole("button", { name: "ЗАРЕГИСТРИРОВАТЬСЯ", exact: true }).count(), 1);
    await installedPage.getByText("Войти", { exact: true }).click();
    await installedPage.getByRole("heading", { name: "Добро пожаловать", exact: true }).waitFor();
    for (const role of ["admin", "system"]) {
      const { path: ignored, ...cookie } = await installedPreview.login(role);
      await installedPage.context().clearCookies(); await installedPage.context().addCookies([{ ...cookie, sameSite: "Lax" }]);
      await installedPage.goto(installed.url + "/admin"); await installedPage.getByRole("heading", { name: "Рабочее пространство", exact: true }).waitFor();
      await checkElements(installedPage, ["admin.title", "admin.description"]);
      await installedPage.goto(installed.url + "/profile"); await installedPage.getByRole("heading", { name: "Мой профиль", exact: true }).first().waitFor();
      await checkElements(installedPage, ["profile.card", "profile.title", "profile.description"]);
      await installedPage.goto(installed.url + "/tasks?tab=edu"); await installedPage.locator(".vates-education-screen").waitFor();
      await checkElements(installedPage, ["learning.title", "learning.testsTitle"]);
      if (role === "system") {
        await installedPage.getByRole("button", { name: "Сотрудник", exact: true }).click();
        // The source router may keep the current tab during refresh; verify the actual mode, not a transient URL.
        await installedPage.locator(".account-mode-switch-button.is-active").filter({ hasText: /^Сотрудник$/ }).waitFor();
        await installedPage.waitForURL((url) => url.pathname === "/tasks");
        // Use the source navigation while its router refreshes; a competing full-page goto can be aborted.
        await installedPage.locator('.nav-sidebar a[href="/tasks?tab=edu"]').click();
        await installedPage.locator(".vates-urgent-learning").waitFor();
        await checkElements(installedPage, ["learning.title", "learning.urgentTitle", "learning.testsTitle"]);
        await installedPage.getByRole("button", { name: "Админ", exact: true }).click();
        await installedPage.getByRole("heading", { name: "Рабочее пространство", exact: true }).waitFor();
      }
      assert.equal(await installedPage.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status), 200);
      await installedPage.goto(installed.url + "/login"); await installedPage.getByRole("heading", { name: "Добро пожаловать", exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    await installedPreview.stop(); assert.equal(installedPreview.get().phase, "stopped");
    assert.equal(hash(await fs.readFile(path.join(path.dirname(payload), "../installation.tar"))), frozen);
    const saved = await f.service.load(f.client.id, snapshot.revision); saved.document.elements["login.title"].text = "Следующая версия"; await f.service.save(saved);
    assert.equal((await plans.get(f.client.id)).status, "blocked");
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify({ checkedAt: new Date().toISOString(), sourceId: adapted.id, revision: snapshot.revision, clientId: f.client.id, artifact: { ...pkg, payloadPath: path.dirname(payload) }, design: prepared.design, visual: expected, unchangedSourceFiles: unchanged, matchedCatalogElements: [...seenElements].sort(), originalLogo: true, originalRadius: true, themeIsolation: true, previewEqualsPayload: true, bothAdmins: true, registration: true, stalePlanBlocked: true, packageImmutable: true, cleanup: true, externalActions: false, errors }, null, 2));
    console.log(JSON.stringify({ output, packageId: pkg.id, previewEqualsPayload: true, visualStates: expected.length, bothAdmins: true }));
  } finally { await browser?.close(); await sourcePreview.stop(); await installedPreview?.stop(); }
});
