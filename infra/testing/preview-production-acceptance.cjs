const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixtureImage } = require("../../apps/control-center/tests/branding-image-fixture.cjs");
const { inspectImage, assetUrl } = require("../scripts/client-brand-assets.cjs");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "infra/runtime/local-acceptance/preview-production-20261029", randomUUID());
const workspace = path.join(output, "workspace");
const app = path.join(workspace, "apps/lms-web");
const clientId = process.env.CORE_PREVIEW_CLIENT_ID || "ffe5afda-f49c-4518-9dea-429dca1dbf1e";

function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }); }
function run(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(text) : reject(new Error(`Isolated Next build failed (${code}): ${text.slice(-12000)}`)));
  });
}

(async () => {
  await fs.mkdir(app, { recursive: true });
  // Copy only public source/configuration. No data, .env, local cache or credentials enter this build.
  for (const name of ["app", "public", "next.config.ts", "next-env.d.ts", "package.json", "tsconfig.json"]) await fs.cp(path.join(root, "apps/lms-web", name), path.join(app, name), { recursive: true });
  // Only the generated acceptance copy uses one build worker on this memory-constrained laptop.
  const copiedConfig = path.join(app, "next.config.ts");
  const configSource = await fs.readFile(copiedConfig, "utf8");
  assert.ok(configSource.includes("const nextConfig: NextConfig = {"));
  await fs.writeFile(copiedConfig, configSource.replace("const nextConfig: NextConfig = {", "const nextConfig: NextConfig = {\n  experimental: { cpus: 1 },"));
  await fs.copyFile(path.join(root, "tsconfig.base.json"), path.join(workspace, "tsconfig.base.json"));
  await fs.mkdir(path.join(workspace, "packages/shared"), { recursive: true });
  await fs.cp(path.join(root, "packages/shared/src"), path.join(workspace, "packages/shared/src"), { recursive: true });
  await fs.symlink(path.join(root, "apps/lms-web/node_modules"), path.join(app, "node_modules"), "junction");
  const originalBuildIdPath = path.join(root, "apps/lms-web/.next/BUILD_ID");
  const originalBuildId = await fs.readFile(originalBuildIdPath, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const headers = { "x-dev-role-code": "system_admin", "x-dev-user-id": "acceptance-read-only", "x-dev-client-id": "acceptance-read-only" };
  const saved = {};
  for (const endpoint of ["client-detail", "preview-settings"]) {
    const response = await fetch(`http://127.0.0.1:3001/api/deploy-panel/${endpoint}?clientId=${encodeURIComponent(clientId)}`, { headers, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    saved[endpoint] = await response.json();
  }
  let mode = "healthy", mockedWrites = 0, mockedImageUploads = 0, imageBytes, imageMetadata, releaseImage, imageStarted;
  const imageGate = new Promise((resolve) => { releaseImage = resolve; });
  const imageRequestStarted = new Promise((resolve) => { imageStarted = resolve; });
  const backend = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const endpoint = url.pathname.split("/").pop();
    if (endpoint === "branding-assets") {
      if (request.method === "POST") {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        imageBytes = Buffer.concat(chunks); const info = inspectImage(imageBytes); mockedImageUploads++;
        const asset = `${info.sha256}.${info.extension}`; imageMetadata = { clientId, asset, url: assetUrl(clientId, asset), ...info };
        imageStarted(); await imageGate;
        response.writeHead(201, { "Content-Type": "application/json" }); return response.end(JSON.stringify(imageMetadata));
      }
      if (imageMetadata && url.searchParams.get("clientId") === clientId && url.searchParams.get("asset") === imageMetadata.asset) {
        response.writeHead(200, { "Content-Type": imageMetadata.mime, "Content-Length": imageBytes.length }); return response.end(imageBytes);
      }
      response.writeHead(404); return response.end();
    }
    if (request.method === "POST") {
      mockedWrites++;
      request.resume();
      response.writeHead(201, { "Content-Type": "application/json" });
      return response.end(JSON.stringify(saved["preview-settings"]));
    }
    if (endpoint === "preview-settings" && mode === "stall") return;
    if (endpoint === "preview-settings" && mode === "fail-settings") { response.writeHead(503); return response.end("private-backend-fixture"); }
    if (endpoint === "preview-settings" && mode === "malformed") { response.writeHead(200, { "Content-Type": "application/json" }); return response.end("not-json-private-fixture"); }
    response.writeHead(saved[endpoint] ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(saved[endpoint] || { message: "Not found" }));
  });
  let server, browser, page;
  try {
    const backendPort = await listen(backend);
    const reserve = http.createServer();
    const port = await listen(reserve); await new Promise((resolve) => reserve.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=3072", DEPLOY_PANEL_API_URL: `http://127.0.0.1:${backendPort}`, NEXT_PUBLIC_LMS_PREVIEW_ORIGIN: origin, CORE_LMS_PREVIEW_ORIGIN: origin };
    const cli = path.join(root, "apps/lms-web/node_modules/next/dist/bin/next");
    const started = Date.now();
    const buildLog = await run([cli, "build", app], { cwd: app, env });
    const buildMs = Date.now() - started;
    await fs.writeFile(path.join(output, "build.log"), buildLog);
    server = spawn(process.execPath, [cli, "start", app, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = "";
    server.stdout.on("data", (chunk) => { serverLog += chunk; }); server.stderr.on("data", (chunk) => { serverLog += chunk; });
    const deadline = Date.now() + 45000;
    while (true) {
      if (server.exitCode !== null) throw new Error(`Isolated Next exited: ${serverLog.slice(-4000)}`);
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error("Isolated Next did not start");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    browser = await chromium.launch({ executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const previewUrl = `${origin}/preview?clientId=${encodeURIComponent(clientId)}`;
    let releaseScripts;
    const scriptsReady = new Promise((resolve) => { releaseScripts = resolve; });
    const heldScripts = new Set();
    await page.route("**/_next/**/*.js*", async (route) => {
      heldScripts.add(new URL(route.request().url()).pathname);
      await scriptsReady;
      await route.continue();
    });
    await page.goto(previewUrl, { waitUntil: "commit" });
    await page.locator('.preview-builder[data-editor-ready="false"]').waitFor({ state: "attached" });
    const earlyTitle = page.locator(".field").filter({ has: page.locator("label", { hasText: /^Главный заголовок$/ }) }).locator("input");
    const beforeHydration = await earlyTitle.inputValue();
    assert.equal(await earlyTitle.evaluate((element) => Boolean(element.closest("[inert]"))), true);
    await assert.rejects(earlyTitle.click({ timeout: 500 }), /Timeout/);
    assert.equal(await earlyTitle.inputValue(), beforeHydration);
    releaseScripts();
    await page.locator('.preview-builder[data-editor-ready="true"]').waitFor();
    assert.ok(heldScripts.size > 0, "The early-input gate must actually hold browser scripts");
    assert.equal(await earlyTitle.evaluate((element) => Boolean(element.closest("[inert]"))), false);
    await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor({ timeout: 30000 });
    const title = page.locator(".field").filter({ has: page.locator("label", { hasText: /^Главный заголовок$/ }) }).locator("input");
    await title.fill("Production build unsaved fixture");
    await page.frameLocator(".runtime-frame").locator('[data-preview-editable="home.title"]').filter({ hasText: "Production build unsaved fixture" }).waitFor();
    await page.frameLocator(".runtime-frame").locator('[data-preview-editable="home.background"]').dispatchEvent("click");
    await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: fixtureImage() });
    let uploadStartDeadline;
    try {
      await Promise.race([imageRequestStarted, new Promise((_, reject) => { uploadStartDeadline = setTimeout(async () => { await page.screenshot({ path: path.join(output, "image-upload-not-started.png") }); reject(Error(`Image upload did not reach fixture API: ${(await page.locator('[role="status"]').allTextContents()).join(" | ")}`)); }, 25000); })]);
    } finally { clearTimeout(uploadStartDeadline); }
    assert.equal(await page.getByRole("button", { name: "Сохранить", exact: true }).isDisabled(), true);
    await page.locator(".inspector-tabs").getByRole("button", { name: "Текст", exact: true }).click();
    await title.fill("Text kept while image is uploading");
    releaseImage();
    await page.getByRole("button", { name: "Сохранить", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector("button.primary-action")?.disabled);
    assert.equal(await title.inputValue(), "Text kept while image is uploading");
    await page.frameLocator(".runtime-frame").locator('[data-preview-editable="home.background"]').evaluate((element) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => { if (getComputedStyle(element).backgroundImage.includes("/api/client-brand-assets?")) return resolve(true); if (Date.now() > deadline) return reject(Error("Image draft did not apply")); setTimeout(check, 50); }; check();
    }));
    const imageResponse = await page.request.get(`${origin}${imageMetadata.url}`);
    assert.equal(imageResponse.status(), 200); assert.deepEqual(await imageResponse.body(), imageBytes);
    mode = "fail-settings";
    await page.goto(previewUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Не удалось открыть LMS" }).waitFor();
    assert.equal(await page.locator(".preview-builder").count(), 0);
    const wrapperPath = path.join(output, "core-parent-fixture.html");
    await fs.writeFile(wrapperPath, `<!doctype html><meta charset="utf-8"><script>
      let generation=0;
      addEventListener('message',event=>{
        const frame=document.querySelector('iframe');
        if(event.source!==frame?.contentWindow||event.origin!==${JSON.stringify(origin)})return;
        if(event.data?.type==='lms-core:client-context-ready'){
          const session='production-session-'+(++generation);
          frame.contentWindow.postMessage({type:'lms-core:client-context',version:1,session,generation},event.origin);
          frame.contentWindow.postMessage({type:'lms-core:panel-state-request',version:1,session,requestId:'production-request'},event.origin);
        }
        if(event.data?.type==='lms-core:panel-state')window.fixtureState=event.data;
      });
    </script><iframe src="${previewUrl}"></iframe>`);
    const wrapperPage = await browser.newPage();
    wrapperPage.on("pageerror", (error) => errors.push(error.message));
    await wrapperPage.goto(pathToFileURL(wrapperPath).href);
    await wrapperPage.waitForFunction(() => window.fixtureState?.clientId !== undefined);
    assert.deepEqual(await wrapperPage.evaluate(() => ({ clientId: window.fixtureState.clientId, dirty: window.fixtureState.dirty, busy: window.fixtureState.busy, blocked: window.fixtureState.blocked })), { clientId, dirty: false, busy: false, blocked: false });
    await wrapperPage.evaluate((url) => { window.fixtureState = null; document.querySelector("iframe").src = url; }, `${origin}/preview`);
    await wrapperPage.waitForFunction(() => window.fixtureState?.clientId === null);
    assert.equal(await wrapperPage.evaluate(() => window.fixtureState.blocked), false);
    await wrapperPage.close();
    assert.ok(!(await page.locator("main").innerText()).includes("private-backend"));
    await page.screenshot({ path: path.join(output, "backend-unavailable.png"), caret: "initial" });
    mode = "malformed";
    await page.getByRole("link", { name: "Повторить загрузку", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "неверный ответ" }).waitFor();
    mode = "stall";
    const timeoutStarted = Date.now();
    await page.getByRole("link", { name: "Повторить загрузку", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "не ответил вовремя" }).waitFor({ timeout: 20000 });
    const backendTimeoutMs = Date.now() - timeoutStarted;
    mode = "healthy";
    await page.getByRole("link", { name: "Повторить загрузку", exact: true }).click();
    await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor();
    const proxy = await page.request.get(`${origin}/api/preview-settings?clientId=${encodeURIComponent(clientId)}`);
    assert.equal(proxy.status(), 200);
    mode = "fail-settings";
    const unavailableProxy = await page.request.get(`${origin}/api/preview-settings?clientId=${encodeURIComponent(clientId)}`);
    assert.equal(unavailableProxy.status(), 503);
    assert.ok(!(await unavailableProxy.text()).includes("private-backend"));
    mode = "healthy";
    const savedProxy = await page.request.post(`${origin}/api/preview-settings`, { data: { clientId, settings: saved["preview-settings"].settings } });
    assert.equal(savedProxy.status(), 201);
    assert.equal(mockedWrites, 1);
    // The live dev server legitimately updates route manifests during HMR; its cache must not become this production build.
    const buildIdAfter = await fs.readFile(originalBuildIdPath, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    assert.equal(buildIdAfter, originalBuildId, "Production acceptance must not replace the live dev build");
    assert.notEqual(await fs.realpath(path.join(app, ".next")), await fs.realpath(path.join(root, "apps/lms-web/.next")));
    const liveEditor = await fetch(`http://127.0.0.1:3100/preview?clientId=${encodeURIComponent(clientId)}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(liveEditor.status, 200);
    assert.deepEqual(errors, []);
    const result = { checkedAt: new Date().toISOString(), isolatedSourceCopy: true, productionBuild: true, buildMs, backendTimeoutMs, earlyInputBlockedUntilHydration: true, heldScriptCount: heldScripts.size, failedAndEmptyPagesAllowBoundCoreExit: true, healthyLiveDraft: true, imageUploadThroughEditor: true, imageProxyPreservesBytes: true, concurrentTextSurvivesImageUpload: true, mockedImageUploads, savedSettingsFailureBlocksEditor: true, invalidJsonVisible: true, timeoutRetryRecovers: true, proxyStatusPreserved: true, realBackendWrites: 0, mockedWrites, runningDevCacheNotReplacedByProduction: true, liveEditorStillResponds: true, errors };
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, output }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(output, "acceptance-error.png") }).catch(() => {});
      await fs.writeFile(path.join(output, "error.json"), JSON.stringify({ message: error.message, frameStatus: await page.locator(".frame-status").allTextContents().catch(() => []), status: await page.locator('[role="status"]').allTextContents().catch(() => []) }, null, 2));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) { server.kill(); await once(server, "exit").catch(() => {}); }
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    const resolvedWorkspace = await fs.realpath(workspace);
    const expectedWorkspace = path.resolve(output, "workspace");
    if (resolvedWorkspace.toLowerCase() !== expectedWorkspace.toLowerCase() || !resolvedWorkspace.toLowerCase().startsWith(`${path.resolve(root, "infra/runtime/local-acceptance").toLowerCase()}${path.sep}`)) throw new Error("Refusing acceptance cleanup outside its own workspace");
    const dependencyLink = path.join(app, "node_modules");
    if (!(await fs.lstat(dependencyLink)).isSymbolicLink()) throw new Error("Refusing cleanup of an unexpected dependency directory");
    await fs.unlink(dependencyLink);
    await fs.rm(resolvedWorkspace, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
