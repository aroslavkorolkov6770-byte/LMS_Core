const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { chromium } = require("playwright");
const { root } = require("./runtime-test-helper.cjs");
const { fixtureClient, loadBaseline, db } = require("./fresh-install-test-helper.cjs");
const { databaseProvisionFixture } = require("./database-provision-test-helper.cjs");
const { roleEnvironment } = require("../../../infra/scripts/runtime-process.cjs");
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function launch(script, args, cwd, env) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { child, log: () => log, ended, stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await ended; } };
}
async function until(process, check) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null || process.child.signalCode !== null) throw Error(`Isolated runtime exited: ${process.log().slice(-3000)}`);
    try { if (await check()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Local readiness timeout: ${process.log().slice(-3000)}`);
}

test("two personalized production packages retain their own saved design, login, empty PostgreSQL materials and restart", { timeout: 1200000 }, async (t) => {
  assert.ok(process.env.CORE_TEST_DESIGN_PACKAGES, "Point to a completed local design-package receipt");
  const receipt = JSON.parse(await fs.readFile(process.env.CORE_TEST_DESIGN_PACKAGES, "utf8"));
  assert.equal(receipt.externalActions, false);
  assert.equal(receipt.packages.length, 2);
  const output = path.join(root, "infra/runtime/local-acceptance/design-runtime-20261029", randomUUID());
  await fs.mkdir(output, { recursive: true });
  const results = [];
  for (const entry of receipt.packages) {
    await t.test(entry.label, { timeout: 550000 }, async (t) => {
      const pkg = entry.artifact, payload = pkg.payloadPath;
      const design = JSON.parse(await fs.readFile(path.join(payload, "lms/core-client-design.json"), "utf8"));
      const packageHash = hash(await fs.readFile(pkg.archivePath));
      const work = path.join(output, entry.clientId), buildRoot = path.join(root, "infra/runtime", `d-${randomUUID().slice(0, 12)}`), app = path.join(buildRoot, "lms");
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(buildRoot);
      // Only the disposable copy receives build output and dependency links; the attested package stays untouched.
      await fs.cp(path.join(payload, "lms"), app, { recursive: true });
      const dependencySource = path.join(root, "infra/runtime/runtime-adapted-sources", pkg.sourceId, "source/node_modules");
      await fs.symlink(dependencySource, path.join(app, "node_modules"), "junction");
      const configPath = path.join(app, "next.config.ts");
      const config = await fs.readFile(configPath, "utf8");
      assert.ok(config.includes("const nextConfig: NextConfig = {"));
      await fs.writeFile(configPath, config.replace("outputFileTracingRoot: projectRoot", `outputFileTracingRoot: ${JSON.stringify(root)}`).replace("const nextConfig: NextConfig = {", `const nextConfig: NextConfig = {\n  experimental: { cpus: 1 },\n  turbopack: { root: ${JSON.stringify(root)} },`));
      const provision = await databaseProvisionFixture(t, entry.clientId);
      await db.provisionClientDatabase(provision.maintenanceUrl, provision.input);
      await db.initializeFreshDatabase(provision.databaseUrl, await loadBaseline(), { ...fixtureClient(), id: entry.clientId });
      const context = { clientId: entry.clientId, releaseId: pkg.id, designSha256: pkg.design.sha256, apiPort: await freePort(), webPort: await freePort() };
      const secrets = { databaseUrl: provision.databaseUrl, serviceToken: randomBytes(32).toString("base64url"), encryptionKey: randomBytes(32).toString("hex"), authSecret: randomBytes(48).toString("base64url") };
      const admins = { clientAdminLogin: "design.admin", clientAdminName: "Design fixture", clientAdminPassword: randomBytes(24).toString("base64url"), systemAdminLogin: "design.system", systemAdminPassword: randomBytes(24).toString("base64url") };
      const apiEnv = roleEnvironment(context, secrets, "api"), webEnv = roleEnvironment(context, secrets, "web");
      const origin = `http://127.0.0.1:${context.webPort}`, api = `http://127.0.0.1:${context.apiPort}/api/lms-runtime/v1`;
      const cli = path.join(app, "node_modules/next/dist/bin/next");
      let apiProcess, webProcess, browser;
      try {
        const build = launch(cli, ["build"], app, { ...process.env, ...webEnv, NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=3072" });
        const buildCode = await build.ended;
        await fs.writeFile(path.join(work, "build.log"), build.log());
        assert.equal(buildCode, 0, build.log().slice(-7000));
        const apiScript = path.join(payload, "backend/runtime-api.cjs");
        apiProcess = launch(apiScript, [], path.dirname(apiScript), { ...apiEnv, LMS_RUNTIME_BOOTSTRAP_ENABLED: "true" });
        const apiReady = async () => (await fetch(`${api}/health`, { headers: { Authorization: `Bearer ${secrets.serviceToken}` }, signal: AbortSignal.timeout(2000) })).ok;
        await until(apiProcess, apiReady);
        const bootstrap = await fetch(`${api}/bootstrap`, { method: "POST", headers: { Authorization: `Bearer ${secrets.serviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify(admins) });
        assert.equal(bootstrap.ok, true);
        await apiProcess.stop();
        apiProcess = launch(apiScript, [], path.dirname(apiScript), apiEnv);
        await until(apiProcess, apiReady);
        const startWeb = async () => {
          webProcess = launch(cli, ["start", "--hostname", "127.0.0.1", "--port", String(context.webPort)], app, webEnv);
          await until(webProcess, async () => (await fetch(`${origin}/api/core-runtime/health`, { signal: AbortSignal.timeout(2000) })).ok);
        };
        await startWeb();
        browser = await chromium.launch({ executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
        const errors = [], blockedCoreCalls = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) return route.continue();
          if (["3001", "3002", "3100"].includes(url.port)) blockedCoreCalls.push(url.pathname);
          return route.abort();
        });
        await page.goto(`${origin}/login`);
        await page.getByRole("heading", { name: design.content.homeTitle, exact: true }).waitFor();
        await page.getByRole("heading", { name: design.content.loginTitle, exact: true }).waitFor();
        const button = page.getByRole("button", { name: design.content.loginButtonLabel, exact: true });
        const visual = await button.evaluate((node) => ({ color: getComputedStyle(node).backgroundColor, font: getComputedStyle(node).fontFamily, radius: getComputedStyle(node).borderRadius }));
        const expectedColor = await page.evaluate((color) => { const el = document.createElement("div"); el.style.backgroundColor = color; document.body.append(el); const result = getComputedStyle(el).backgroundColor; el.remove(); return result; }, entry.primary);
        assert.equal(visual.color, expectedColor); assert.ok(visual.font.includes(entry.font)); assert.equal(visual.radius, "12px");
        assert.ok((await page.locator("body").evaluate((node) => getComputedStyle(node).fontFamily)).includes(entry.font));
        assert.equal(await page.title(), design.brandName);
        if (design.version === 2) {
          assert.equal(design.assets.length, 1);
          const response = await fetch(`${origin}/${design.assets[0].path}`);
          assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), design.assets[0].sha256);
          const hero = page.locator('[data-core-element="home.background"]');
          assert.ok((await hero.evaluate((node) => getComputedStyle(node).backgroundImage)).includes(design.content.homeBackgroundImageUrl));
          assert.equal(await hero.locator(".core-client-brand").evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)");
          const titleStyle = await page.locator('[data-core-element="home.title"]').evaluate((node) => ({ color: getComputedStyle(node).color, translate: getComputedStyle(node).translate, padding: getComputedStyle(node).padding, align: getComputedStyle(node).textAlign }));
          assert.equal(titleStyle.color, "rgb(131, 67, 34)"); assert.equal(titleStyle.translate, "14px 3px"); assert.equal(titleStyle.padding, "8px"); assert.equal(titleStyle.align, "left");
          assert.equal(await page.locator('[data-core-element="login.card"]').evaluate((node) => getComputedStyle(node).borderRadius), `${design.layout.cardRadiusPx}px`);
          assert.equal(await button.evaluate((node) => getComputedStyle(node).boxShadow === "none"), !design.components.buttonShadow);
          await page.getByRole("link", { name: new RegExp(design.content.navHomeLabel) }).waitFor();
        }
        await page.screenshot({ path: path.join(work, "login.png"), animations: "disabled" });
        await page.getByPlaceholder("Логин", { exact: true }).fill(admins.clientAdminLogin);
        await page.locator('input[type="password"]').first().fill(admins.clientAdminPassword);
        await button.click();
        await page.waitForURL(/\/(admin|tasks)/, { timeout: 20000 });
        await page.goto(`${origin}/admin`);
        await page.getByRole("heading", { name: design.content.adminTitle, exact: true }).waitFor();
        await page.goto(`${origin}/profile`);
        await page.getByRole("heading", { name: design.content.profileTitle, exact: true }).first().waitFor();
        if (design.version === 2) assert.equal(await page.locator('[data-core-element="profile.subtitle"]').isVisible(), design.elementOverrides["profile.subtitle"].visible);
        await page.goto(`${origin}/tasks?tab=edu`);
        await page.getByRole("heading", { name: design.content.learningTheoryTitle, exact: true }).waitFor();
        const systemLogin = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ login: admins.systemAdminLogin, password: admins.systemAdminPassword }) });
        assert.equal(systemLogin.status, 200);
        assert.equal((await systemLogin.json()).user.systemAccount, true);
        const systemCookie = systemLogin.headers.get("set-cookie").split(";")[0];
        const systemLogout = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: systemCookie }, body: "{}" });
        assert.equal(systemLogout.status, 200);
        for (const key of ["tea_hub_dynamic_route_v2", "tea_hub_dynamic_tests_v1"]) {
          const data = await page.evaluate(async (key) => { const response = await fetch(`/api/storage?key=${encodeURIComponent(key)}`, { credentials: "same-origin" }); return { status: response.status, body: await response.json() }; }, key);
          assert.equal(data.status, 200, `Empty materials read: ${data.status}`); assert.deepEqual(data.body, []);
        }
        await page.screenshot({ path: path.join(work, "empty-learning.png"), animations: "disabled" });
        await webProcess.stop(); await startWeb();
        await page.goto(`${origin}/login`);
        await page.getByRole("heading", { name: design.content.homeTitle, exact: true }).waitFor();
        assert.equal(await page.evaluate(async () => (await (await fetch("/api/auth/session", { credentials: "same-origin" })).json()).authenticated), true);
        if (design.version === 2) {
          const response = await fetch(`${origin}/${design.assets[0].path}`);
          assert.equal(hash(Buffer.from(await response.arrayBuffer())), design.assets[0].sha256);
        }
        assert.equal(hash(await fs.readFile(pkg.archivePath)), packageHash);
        assert.deepEqual(blockedCoreCalls, []); assert.deepEqual(errors, []);
        results.push({ clientId: entry.clientId, packageId: pkg.id, designVersion: design.version, designSha256: pkg.design.sha256, productionBuild: true, visual, images: design.assets?.length || 0, semanticElementStyles: design.version === 2, login: true, systemAdminLoginLogout: true, emptyMaterials: true, restart: true, coreIndependent: true, errors });
      } finally {
        if (browser) await browser.close();
        if (webProcess) await webProcess.stop();
        if (apiProcess) await apiProcess.stop();
        const resolved = await fs.realpath(app);
        assert.equal(resolved.toLowerCase(), path.resolve(buildRoot, "lms").toLowerCase());
        assert.equal(path.dirname(buildRoot), path.join(root, "infra/runtime"));
        assert.match(path.basename(buildRoot), /^d-[a-f0-9-]{12}$/);
        assert.equal((await fs.lstat(path.join(app, "node_modules"))).isSymbolicLink(), true);
        await fs.unlink(path.join(app, "node_modules"));
        await fs.rm(buildRoot, { recursive: true, force: true, maxRetries: 3 });
      }
    });
  }
  assert.equal(results.length, 2);
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify({ checkedAt: new Date().toISOString(), results, externalActions: false }, null, 2));
  console.log(JSON.stringify({ output, results }));
});
