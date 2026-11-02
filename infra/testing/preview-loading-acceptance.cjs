const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const clientId = process.env.CORE_PREVIEW_CLIENT_ID || "ffe5afda-f49c-4518-9dea-429dca1dbf1e";
const output = path.join(root, "infra/runtime/local-acceptance/preview-loading-20261029", randomUUID());

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const mutations = [], errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\//, (route) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) { mutations.push(new URL(route.request().url()).pathname); return route.abort(); }
      return route.continue();
    });
    let intercept = true;
    await context.route((url) => url.origin === "http://127.0.0.1:3100" && url.pathname === "/" && url.searchParams.has("previewClientId"), (route) => {
      if (intercept && route.request().isNavigationRequest()) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><html><body><p>Local acceptance: missing preview handshake</p></body></html>" });
      return route.continue();
    });
    const started = Date.now();
    await page.goto(`http://127.0.0.1:3100/preview?clientId=${encodeURIComponent(clientId)}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator(".frame-loading-cover").waitFor();
    await page.getByRole("button", { name: "Повторить загрузку", exact: true }).waitFor({ timeout: 45000 });
    const timeoutObservedMs = Date.now() - started;
    assert.equal(await page.locator(".frame-loading-cover").count(), 0);
    assert.match(await page.locator(".frame-status").getAttribute("title"), /LMS не ответила/);
    await page.screenshot({ path: path.join(output, "timeout.png"), caret: "initial" });
    intercept = false;
    await page.getByRole("button", { name: "Повторить загрузку", exact: true }).click();
    await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor({ timeout: 60000 });
    await page.frameLocator(".runtime-frame").locator('[data-preview-editable="home.title"]').waitFor();
    const resource = `/__core_acceptance_resource_${randomUUID()}`;
    await context.route(`http://127.0.0.1:3100${resource}`, (route) => route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "Local resource acceptance. No client data." }));
    await page.locator(".runtime-frame").evaluate((iframe, resource) => { iframe.src = resource; }, resource);
    await page.locator(".frame-status").filter({ hasText: "Просмотр ресурса" }).waitFor();
    assert.equal(await page.locator(".frame-loading-cover").count(), 0);
    await page.locator(".top-actions").getByRole("button", { name: "Главная", exact: true }).click();
    await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor({ timeout: 60000 });
    assert.deepEqual(mutations, []);
    assert.deepEqual(errors, []);
    const result = { checkedAt: new Date().toISOString(), realNextUi: true, clientId, timeoutObservedMs, timeoutVisible: true, retryRecovered: true, nonHtmlResourceDoesNotWaitForHandshake: true, homeRecovered: true, blockedMutations: mutations, errors };
    await page.screenshot({ path: path.join(output, "recovered.png"), caret: "initial" });
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, output }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
