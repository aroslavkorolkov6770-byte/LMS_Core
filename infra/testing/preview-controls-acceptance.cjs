const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { isolatedNext, listen } = require("./isolated-next.cjs");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "infra/runtime/local-acceptance/preview-controls-20261029", randomUUID());
const clientId = "ffe5afda-f49c-4518-9dea-429dca1dbf1e";

(async () => {
  await fs.mkdir(output, { recursive: true });
  const headers = { "x-dev-role-code": "system_admin", "x-dev-user-id": "acceptance-read-only", "x-dev-client-id": "acceptance-read-only" };
  const fixtures = {};
  for (const endpoint of ["client-detail", "preview-settings"]) {
    const response = await fetch(`http://127.0.0.1:3001/api/deploy-panel/${endpoint}?clientId=${clientId}`, { headers, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); fixtures[endpoint] = await response.json();
  }
  const backendWrites = [];
  const backend = http.createServer((request, response) => {
    const endpoint = new URL(request.url, "http://localhost").pathname.split("/").pop();
    if (request.method !== "GET") { backendWrites.push(endpoint); response.writeHead(405); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(fixtures[endpoint] || {}));
  });
  let isolated, browser;
  try {
    const backendPort = await listen(backend);
    isolated = await isolatedNext(root, "lms-web", output, `http://127.0.0.1:${backendPort}`);
    browser = await chromium.launch({ executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const errors = [], mutations = [], hydrationErrors = [];
    await context.addInitScript((clientId) => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      set.call(localStorage, `lms-preview-control:${clientId}`, JSON.stringify({ selectMode: false, dragMode: true, selectedId: "home.title" }));
      window.__coreControlStorageAccess = 0;
      Storage.prototype.getItem = function(key) { if (String(key).startsWith("lms-preview-control:")) { window.__coreControlStorageAccess++; throw new Error("Acceptance: control storage disabled"); } return get.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (String(key).startsWith("lms-preview-control:")) { window.__coreControlStorageAccess++; throw new Error("Acceptance: control storage disabled"); } return set.call(this, key, value); };
    }, clientId);
    await context.route("**/*", (route) => {
      const request = route.request(), url = new URL(request.url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== isolated.origin) return route.abort();
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) { mutations.push(url.pathname); return route.abort(); }
      if (url.pathname === "/api/storage") return route.fulfill({ status: 200, json: url.searchParams.has("keys") ? Object.fromEntries((url.searchParams.get("keys") || "").split(",").map((key) => [key, []])) : [] });
      return route.continue();
    });
    async function openEditor() {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error" && /hydrat|server rendered|didn't match/i.test(message.text())) hydrationErrors.push(message.text().split("\n")[0]); });
      await page.goto(`${isolated.origin}/preview?clientId=${clientId}`, { waitUntil: "domcontentloaded" });
      await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor({ timeout: 45000 });
      await page.frameLocator(".runtime-frame").locator('body[data-preview-select-mode="1"]').waitFor();
      return page;
    }
    const first = await openEditor(), a = first.frameLocator(".runtime-frame");
    await first.getByRole("button", { name: "Выбор включен", exact: true }).click();
    await a.locator('body[data-preview-select-mode="0"]').waitFor();
    const second = await openEditor(), b = second.frameLocator(".runtime-frame");
    assert.equal(await a.locator("body").getAttribute("data-preview-select-mode"), "0");
    assert.equal(await b.locator("body").getAttribute("data-preview-select-mode"), "1");
    const originalA = await a.locator('[data-preview-editable="home.title"]').textContent();
    const marker = randomUUID();
    await b.locator("body").evaluate((_body, marker) => { window.__coreControlDocument = marker; }, marker);
    await b.locator("body").evaluate(async () => { await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))); });
    for (const text of ["Inline first fixture", "Inline second fixture"]) {
      await b.locator('[data-preview-editable="home.title"]').dblclick();
      const inline = b.getByRole("textbox", { name: "Редактировать текст выбранного блока", exact: true });
      await inline.fill(text); await inline.press("Enter");
      await b.locator('[data-preview-editable="home.title"]').filter({ hasText: text }).waitFor();
      await inline.waitFor({ state: "hidden" });
    }
    await second.getByRole("checkbox", { name: "Перемещать мышкой", exact: true }).check();
    const handle = b.getByRole("button", { name: "Переместить выбранный блок", exact: true });
    await handle.waitFor();
    const bounds = await handle.boundingBox(); assert.ok(bounds);
    await second.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await second.mouse.down();
    await second.mouse.move(bounds.x + bounds.width / 2 + 48, bounds.y + bounds.height / 2 + 24, { steps: 6 }); await second.mouse.up();
    await second.locator(".drag-readout").getByText("X: 48px", { exact: true }).waitFor();
    await second.locator(".drag-readout").getByText("Y: 24px", { exact: true }).waitFor();
    await second.locator(".inspector-tabs").getByRole("button", { name: "Текст", exact: true }).click();
    const title = second.locator(".field").filter({ has: second.locator("label", { hasText: /^Главный заголовок$/ }) }).locator("input");
    await title.fill("Panel after inline fixture");
    await b.locator('[data-preview-editable="home.title"]').filter({ hasText: "Panel after inline fixture" }).waitFor();
    assert.equal(await b.locator("body").evaluate(() => window.__coreControlDocument), marker);
    assert.equal(await a.locator('[data-preview-editable="home.title"]').textContent(), originalA);
    assert.equal(await a.locator("body").getAttribute("data-preview-select-mode"), "0");
    assert.equal(await a.locator("#lms-preview-inline-text-editor").count(), 0);
    assert.equal(await a.locator("#lms-preview-drag-handle").count(), 0);
    const storageCounts = [];
    for (const page of [first, second]) { storageCounts.push(await page.evaluate(() => window.__coreControlStorageAccess)); storageCounts.push(await page.frameLocator(".runtime-frame").locator("body").evaluate(() => window.__coreControlStorageAccess)); }
    assert.deepEqual(storageCounts, [0, 0, 0, 0]);
    assert.deepEqual(mutations, []); assert.deepEqual(backendWrites, []); assert.deepEqual(errors, []); assert.deepEqual(hydrationErrors, []);
    const result = { checkedAt: new Date().toISOString(), realProductionUi: true, buildMs: isolated.buildMs, sameClientTwoEditorsIsolated: true, controlStorageBlockedAndNeverUsed: true, storageCounts, inlineEditTwiceThenPanelEdit: true, dragOffset: { x: 48, y: 24 }, documentRetained: true, realBackendWrites: 0, blockedMutations: mutations, errors, hydrationErrors };
    await second.screenshot({ path: path.join(output, "second-editor.png"), caret: "initial" });
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, output }));
  } finally {
    if (browser) await browser.close(); if (isolated) await isolated.cleanup();
    backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve));
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
