const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { isolatedNext, listen } = require("./isolated-next.cjs");
const root = path.resolve(__dirname, "../..");

(async () => {
  const output = path.join(root, "infra/runtime/local-acceptance/client-directory-20261029", randomUUID());
  await fs.mkdir(output, { recursive: true });
  const headers = { "x-dev-role-code": "system_admin", "x-dev-user-id": "acceptance-read-only", "x-dev-client-id": "acceptance-read-only" };
  async function read(endpoint) { const response = await fetch(`http://127.0.0.1:3001/api/deploy-panel/${endpoint}`, { headers, signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200); return response.json(); }
  const dashboard = await read("dashboard"), details = new Map(), writes = [];
  assert.ok(dashboard.clients.length >= 2);
  for (const [index, client] of dashboard.clients.entries()) {
    const detail = await read(`client-detail?clientId=${client.id}`);
    if (!detail.profile) continue;
    // Public UI fixtures never modify the real client or expose its operator notes.
    Object.assign(client, { name: `Клиент ${String(index + 1).padStart(2, "0")}`, brandName: `Проект ${index + 1}`, domain: `client-${index + 1}.example` });
    Object.assign(detail.client, client); detail.profile.brandName = client.brandName;
    details.set(client.id, detail);
  }
  dashboard.clients = dashboard.clients.filter((client) => details.has(client.id));
  assert.ok(dashboard.clients.length >= 2, "Need two existing profile templates for local read-only fixtures");
  const first = dashboard.clients[0], second = dashboard.clients[1];
  const backend = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    response.setHeader("Content-Type", "application/json");
    if (request.method !== "GET") { writes.push(url.pathname); response.writeHead(403); response.end("{}"); return; }
    if (url.pathname.endsWith("/dashboard")) response.end(JSON.stringify(dashboard));
    else if (url.pathname.endsWith("/client-detail")) response.end(JSON.stringify(details.get(url.searchParams.get("clientId"))));
    else { response.writeHead(404); response.end("{}"); }
  });
  let isolated, browser;
  try {
    const port = await listen(backend);
    console.log("Building isolated client panel...");
    isolated = await isolatedNext(root, "deploy-panel", output, `http://127.0.0.1:${port}`);
    browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } }), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let accept = true; page.on("dialog", (dialog) => accept ? dialog.accept() : dialog.dismiss());
    await page.goto(`${isolated.origin}/?clientId=${first.id}`);
    await page.locator('main[data-panel-ready="true"]').waitFor();
    assert.equal(await page.locator("main").getAttribute("data-workspace-mode"), "list");
    assert.equal(await page.locator("#client-card").isVisible(), false);
    assert.equal(await page.locator("#client-editor").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Новый клиент", exact: true }).isVisible(), true);
    const search = page.getByLabel("Поиск клиента", { exact: true });
    await search.fill("not-present-fixture");
    await page.getByText("Клиенты не найдены. Измените запрос или сбросьте поиск.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Сбросить поиск", exact: true }).click();
    await page.waitForFunction((count) => document.querySelectorAll(".client-card-button").length === count, dashboard.clients.length);
    for (const theme of ["ember", "porcelain"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.coreTheme = theme; document.documentElement.dataset.coreColorScheme = theme === "porcelain" ? "light" : "dark"; }, theme);
      for (const width of [1180, 900, 680]) {
        await page.setViewportSize({ width, height: 800 });
        const layout = await page.locator("main").evaluate((element) => ({
          width: element.clientWidth, scrollWidth: element.scrollWidth,
          overflowing: [...element.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1).slice(0, 12).map((child) => ({ tag: child.tagName, className: child.className, width: child.getBoundingClientRect().width }))
        }));
        if (layout.scrollWidth > layout.width + 1) await page.screenshot({ path: path.join(output, `overflow-${theme}-${width}.png`) });
        assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify({ theme, width, ...layout }));
      }
      await page.setViewportSize({ width: 1180, height: 800 });
      await page.screenshot({ path: path.join(output, `clients-${theme}.png`) });
    }
    await page.locator(`[data-client-id="${first.id}"]`).click();
    await page.locator('main[data-workspace-mode="client"]').waitFor();
    assert.equal(await page.locator("#client-list").isVisible(), false);
    const profile = page.locator("#deploy-profile-editor");
    assert.equal(await profile.isVisible(), false);
    await page.screenshot({ path: path.join(output, "client-card.png") });
    await page.getByRole("button", { name: "Редактировать", exact: true }).click();
    const brand = profile.getByLabel("Название бренда", { exact: true });
    await brand.fill("Retained client draft");
    await page.getByRole("button", { name: "К списку клиентов", exact: true }).click();
    await page.locator(`[data-client-id="${first.id}"]`).click();
    assert.equal(await brand.inputValue(), "Retained client draft");
    await page.getByRole("button", { name: "К списку клиентов", exact: true }).click();
    accept = false; await page.locator(`[data-client-id="${second.id}"]`).click();
    assert.equal(await page.locator("main").getAttribute("data-workspace-mode"), "list");
    assert.ok(page.url().includes(first.id));
    accept = true; await page.locator(`[data-client-id="${first.id}"]`).click();
    await profile.getByRole("button", { name: "Отменить правки", exact: true }).click();
    await page.getByRole("button", { name: "Мониторинг", exact: true }).click();
    await page.locator('main[data-workspace-mode="monitoring"]').waitFor();
    assert.equal(await page.locator(".operator-cockpit").isVisible(), true);
    await page.getByRole("button", { name: "К списку клиентов", exact: true }).click();
    await page.getByRole("button", { name: "Новый клиент", exact: true }).click();
    const name = page.locator("#client-editor").getByLabel("Название клиента", { exact: true });
    await name.fill("Retained new client draft");
    await page.getByRole("button", { name: "К списку клиентов", exact: true }).click();
    await page.getByRole("button", { name: "Новый клиент", exact: true }).click();
    assert.equal(await name.inputValue(), "Retained new client draft");
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    const receipt = { checkedAt: new Date().toISOString(), startWithList: true, search: true, selectedClientSeparate: true, profileCollapsed: true, monitorSeparate: true, profileDraftRetained: true, cancelledClientSwitchRetainsDraft: true, createDraftRetained: true, lightDarkLayouts: true, realApiReadOnly: true, simulatedWrites: writes.length, output };
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
  } finally { if (browser) await browser.close(); if (isolated) await isolated.cleanup(); backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve)); }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
