const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright-core");
const { root, apiRequire } = require("./runtime-test-helper.cjs");
const { fixtureClient, loadBaseline, db } = require("./fresh-install-test-helper.cjs");
const { databaseProvisionFixture } = require("./database-provision-test-helper.cjs");
const { roleEnvironment } = require("../../../infra/scripts/runtime-process.cjs");
async function free() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
async function until(check) { const end = Date.now() + 45000; while (Date.now() < end) { try { if (await check()) return; } catch (error) { if (error.code === "PROCESS_EXITED") throw error; } await new Promise((resolve) => setTimeout(resolve, 100)); } throw Error("Local application readiness timed out"); }
function launch(script, args, cwd, env) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  const ended = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await ended; };
  stop.child = child;
  return stop;
}

test("production Git LMS uses the new PostgreSQL backend, sessions, pilot fixtures and browser UI", { timeout: 180000 }, async (t) => {
  const sourceId = process.env.CORE_TEST_LMS_SOURCE_ID;
  const employeeFlow = process.env.CORE_TEST_LMS_EMPLOYEE_FLOW || "activation";
  assert.ok(["activation", "direct"].includes(employeeFlow));
  assert.match(sourceId || "", /^[a-f0-9-]{36}$/);
  const source = path.join(root, "infra/runtime/runtime-adapted-sources", sourceId, "source");
  const adapted = JSON.parse(await fs.readFile(path.join(path.dirname(source), "manifest.json"), "utf8"));
  assert.equal(adapted.adapterVersion, 3); assert.equal(adapted.contentMode, "empty");
  await fs.stat(path.join(source, ".next/BUILD_ID"));
  const provision = await databaseProvisionFixture(t);
  await db.provisionClientDatabase(provision.maintenanceUrl, provision.input);
  const databaseUrl = provision.databaseUrl, sql = provision.connect(databaseUrl);
  const client = { ...fixtureClient(), id: provision.input.clientId };
  await db.assertRestrictedDatabaseRole(databaseUrl, client.id);
  await db.initializeFreshDatabase(databaseUrl, await loadBaseline(), client);
  const context = { clientId: client.id, releaseId: randomUUID(), apiPort: await free(), webPort: await free() };
  const secrets = { databaseUrl, serviceToken: randomBytes(32).toString("base64url"), encryptionKey: randomBytes(32).toString("hex"), authSecret: randomBytes(48).toString("base64url") };
  const origin = `http://127.0.0.1:${context.webPort}`, api = `http://127.0.0.1:${context.apiPort}/api/lms-runtime/v1`;
  const privateCall = async (action, body) => {
    const response = await fetch(`${api}/${action}`, { method: action === "write" ? "PUT" : "POST", headers: { Authorization: `Bearer ${secrets.serviceToken}`, "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    assert.equal(response.ok, true, `Private ${action} failed with ${response.status}`);
    return response.json();
  };
  const call = async (route, body, cookie) => {
    const response = await fetch(`${origin}${route}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const admins = { clientAdminLogin: "fixture.admin", clientAdminName: "Local fixture", clientAdminPassword: randomBytes(24).toString("base64url"), systemAdminLogin: "fixture.system", systemAdminPassword: randomBytes(24).toString("base64url") };
  let stopApi, stopWeb, browser;
  try {
    stopApi = launch(path.join(root, "apps/api/dist/runtime-main.js"), [], root, { ...roleEnvironment(context, secrets, "api"), LMS_RUNTIME_BOOTSTRAP_ENABLED: "true" });
    const apiReady = async () => {
      if (stopApi.child.exitCode !== null || stopApi.child.signalCode !== null) throw Object.assign(Error("Private API process exited during startup"), { code: "PROCESS_EXITED" });
      const response = await fetch(`${api}/health`, { headers: { Authorization: `Bearer ${secrets.serviceToken}`, Connection: "close" }, signal: AbortSignal.timeout(2000) });
      return response.ok && (await response.json()).service === "lms-core-runtime-api";
    };
    await until(apiReady); await privateCall("bootstrap", admins); await stopApi();
    stopApi = launch(path.join(root, "apps/api/dist/runtime-main.js"), [], root, roleEnvironment(context, secrets, "api"));
    await until(apiReady);
    stopWeb = launch(path.join(source, "node_modules/next/dist/bin/next"), ["start", "--hostname", "127.0.0.1", "--port", String(context.webPort)], source, roleEnvironment(context, secrets, "web"));
    await until(async () => (await fetch(`${origin}/api/core-runtime/health`)).ok);
    const health = await call("/api/core-runtime/health"); assert.equal(health.body.releaseId, context.releaseId);
    const login = await call("/api/auth/login", { login: admins.clientAdminLogin, password: admins.clientAdminPassword });
    assert.equal(login.status, 200); assert.ok(login.cookie.startsWith(`core_lms_session_${client.id.replaceAll("-", "")}`));
    const system = await call("/api/auth/login", { login: admins.systemAdminLogin, password: admins.systemAdminPassword });
    assert.equal(system.status, 200); assert.equal(system.body.user.systemAccount, true);
    assert.equal((await call("/api/auth/session", undefined, login.cookie)).body.authenticated, true);
    // Use existing pilot lesson/test data only in this disposable local DB, never in the release package.
    const lessons = [{ id: "core-acceptance-material", title: "Изолированный проверочный материал", theory: "Проверка сохранения материала в одноразовой БД.", content: "Проверка сохранения материала в одноразовой БД." }];
    const tests = [{ id: "core-acceptance-test", title: "Изолированная проверка знаний", subtitle: "Только приемка", theory: "Тестовые данные не включаются в пакет.", quiz: [{ q: "Проверочный вопрос", o: ["Да", "Нет"], c: 0 }] }];
    assert.deepEqual((await call("/api/storage?key=tea_hub_dynamic_route_v2", undefined, login.cookie)).body, []);
    assert.deepEqual((await call("/api/storage?key=tea_hub_dynamic_tests_v1", undefined, login.cookie)).body, []);
    const staffPassword = randomBytes(24).toString("base64url");
    assert.equal((await call("/api/admin/users", { name: "Fixture staff", login: "fixture.staff", password: staffPassword, role: "staff" }, login.cookie)).status, 200);
    const firstStaffLogin = await call("/api/auth/login", { login: "fixture.staff", password: staffPassword });
    if (employeeFlow === "direct") {
      // The reduced beta deliberately permits immediate login; do not reintroduce activation.
      assert.equal(firstStaffLogin.status, 200); assert.equal(firstStaffLogin.body.success, true); assert.ok(firstStaffLogin.cookie);
      assert.notEqual(firstStaffLogin.body.requiresRegistration, true);
    } else {
      assert.equal(firstStaffLogin.body.requiresRegistration, true);
      // Activate only this disposable fixture; registration/DNS are outside this test.
      const entry = (await privateCall("read", { keys: ["core_lms_users_v1"] })).entries[0];
      await privateCall("write", { key: entry.key, expectedRevision: entry.revision, data: entry.data.map((user) => user.login === "fixture.staff" ? { ...user, isRegistered: true, registered: true } : user) });
    }
    const staff = await call("/api/auth/login", { login: "fixture.staff", password: staffPassword }); assert.equal(staff.status, 200);
    browser = await chromium.launch({ executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("**/*", (route) => { const url = new URL(route.request().url()); return ["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort(); });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/login`);
    await page.getByPlaceholder("Логин", { exact: true }).fill(admins.clientAdminLogin);
    await page.locator('input[type="password"]').first().fill(admins.clientAdminPassword);
    await page.getByRole("button", { name: /^Войти$/i }).click();
    await page.waitForURL(/\/(admin|tasks)/, { timeout: 20000 });
    await page.goto(`${origin}/tasks?tab=edu`);
    await page.getByRole("heading", { name: "Материалы", exact: true }).waitFor();
    assert.equal(await page.getByText(tests[0].title, { exact: true }).count(), 0);
    const output = path.join(root, "infra/runtime/local-acceptance", sourceId);
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "lms-empty-materials.png"), fullPage: false, animations: "disabled" });
    for (const [key, data] of [["tea_hub_dynamic_route_v2", [lessons[0]]], ["tea_hub_dynamic_tests_v1", [tests[0]]], ["file_data_local_fixture", "data:text/plain;base64,bG9jYWwtZml4dHVyZQ=="]]) {
      assert.equal((await call("/api/storage", { key, data }, login.cookie)).status, 200);
      assert.deepEqual((await call(`/api/storage?key=${key}`, undefined, login.cookie)).body, data);
    }
    assert.equal((await call("/api/storage?key=tea_hub_dynamic_route_v2", undefined, staff.cookie)).body[0].title, lessons[0].title);
    await page.reload();
    await page.getByText(lessons[0].title, { exact: true }).first().waitFor({ timeout: 20000 });
    await page.getByText(lessons[0].title, { exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "lms-education.png"), fullPage: false, animations: "disabled" });
    assert.deepEqual(errors, []);
    assert.equal((await call("/api/auth/logout", {}, login.cookie)).status, 200);
    await browser.close(); browser = null;
    await stopWeb(); stopWeb = null;
    stopWeb = launch(path.join(source, "node_modules/next/dist/bin/next"), ["start", "--hostname", "127.0.0.1", "--port", String(context.webPort)], source, roleEnvironment(context, secrets, "web"));
    await until(async () => (await fetch(`${origin}/api/core-runtime/health`)).ok);
    assert.equal((await call("/api/storage?key=tea_hub_dynamic_route_v2", undefined, staff.cookie)).body[0].title, lessons[0].title);
    assert.equal((await sql`SELECT count(*)::int AS count FROM lms_runtime_values`)[0].count > 0, true);
    await assert.rejects(fs.stat(path.join(source, "data")), { code: "ENOENT" });
    const adaptationSha256 = createHash("sha256").update(JSON.stringify({ revision: adapted.revision, modifiedFiles: adapted.modifiedFiles, createdFiles: adapted.createdFiles, contentMode: adapted.contentMode })).digest("hex");
    await fs.writeFile(path.join(output, "acceptance.json"), JSON.stringify({ sourceId, revision: adapted.revision, adaptationSha256, contentMode: "empty", productionBuild: true, localEndToEnd: true, restrictedDatabaseRole: true, employeeFlow, checkedAt: new Date().toISOString() }, null, 2));
  } finally { if (browser) await browser.close(); if (stopWeb) await stopWeb(); if (stopApi) await stopApi(); }
});
