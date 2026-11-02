const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { isolatedNext, listen } = require("./isolated-next.cjs");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "infra/runtime/local-acceptance/panel-commands-20261029", randomUUID());
const clientId = "ffe5afda-f49c-4518-9dea-429dca1dbf1e";

(async () => {
  await fs.mkdir(output, { recursive: true });
  const headers = { "x-dev-role-code": "system_admin", "x-dev-user-id": "acceptance-read-only", "x-dev-client-id": "acceptance-read-only" };
  async function readApi(endpoint) { const response = await fetch(`http://127.0.0.1:3001/api/deploy-panel/${endpoint}`, { headers, signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200); return response.json(); }
  const dashboard = await readApi("dashboard"), details = new Map();
  for (const client of dashboard.clients) details.set(client.id, await readApi(`client-detail?clientId=${encodeURIComponent(client.id)}`));
  const otherId = dashboard.clients.find((client) => client.id !== clientId)?.id;
  assert.ok(details.has(clientId) && otherId);
  const calls = [], errors = [], unexpectedRequests = [];
  let holdCommand = null, releaseCommand, failCommand = null, failDashboard = false, malformedCommand = null;
  const backend = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost"), command = url.pathname.split("/").pop();
    const send = (status, payload) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(payload)); };
    if (request.method === "GET") {
      if (command === "dashboard") return failDashboard ? send(503, { message: "private fixture error" }) : send(200, dashboard);
      if (command === "client-detail") return send(200, details.get(url.searchParams.get("clientId")));
      if (command === "validate-client") { calls.push(command); return failCommand === command ? send(503, {}) : send(200, { isValid: true, passedCount: 13, failedCount: 0 }); }
      return send(404, {});
    }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    calls.push(command);
    if (holdCommand === command) await new Promise((resolve) => { releaseCommand = resolve; });
    if (failCommand === command) return send(503, { message: "private fixture failure" });
    if (malformedCommand === command) { response.writeHead(200, { "Content-Type": "application/json" }); return response.end("not-json-private-fixture"); }
    if (command === "bootstrap-client") {
      const id = randomUUID(), template = structuredClone(details.get(clientId));
      Object.assign(template.client, { id, name: payload.name, brandName: payload.brandName, domain: payload.domain, deployStatus: "draft", deployStatusLabel: "Черновик" });
      Object.assign(template.profile, { clientId: id, status: "draft" });
      details.set(id, template); dashboard.clients.push(template.client); dashboard.summary.totalClients++;
      return send(201, { clientId: id });
    }
    const detail = details.get(payload.clientId);
    if (!detail) return send(404, {});
    if (command === "update-deploy-profile") {
      for (const key of Object.keys(detail.profile)) if (payload[key] !== undefined && !/password/i.test(key)) detail.profile[key] = payload[key];
      detail.client.brandName = payload.brandName;
      const card = dashboard.clients.find((client) => client.id === payload.clientId); card.brandName = payload.brandName;
      return send(201, { status: detail.profile.status });
    }
    if (command.startsWith("mark-")) {
      const status = { "mark-draft": "draft", "mark-validated": "validated", "mark-ready-to-deploy": "ready_to_deploy", "mark-deployed": "deployed" }[command];
      detail.profile.status = status; detail.client.deployStatus = status; detail.validation.isValid = true;
      return send(201, { status });
    }
    if (command === "run-deploy") return send(201, { status: "ready_to_deploy", steps: [{ label: "Acceptance package only" }] });
    if (command === "run-health-check") return send(201, { healthyCount: 4, degradedCount: 0, downCount: 0, unknownCount: 0 });
    return send(404, {});
  });
  let isolated, browser, releaseScripts;
  try {
    const backendPort = await listen(backend);
    isolated = await isolatedNext(root, "deploy-panel", output, `http://127.0.0.1:${backendPort}`);
    browser = await chromium.launch({ executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const scriptGate = new Promise((resolve) => { releaseScripts = resolve; });
    await context.route("**/*", (route) => {
      const request = route.request(), url = new URL(request.url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== isolated.origin) { if (!["GET", "HEAD"].includes(request.method())) unexpectedRequests.push(url.pathname); return route.abort(); }
      if (request.resourceType() === "script") return scriptGate.then(() => route.continue());
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const hydrationErrors = [];
    page.on("console", (message) => { if (/hydrat|server rendered HTML/i.test(message.text())) hydrationErrors.push(message.text().slice(0, 2000)); });
    let dismissNextDialog = false;
    page.on("dialog", (dialog) => { if (dismissNextDialog) { dismissNextDialog = false; return dialog.dismiss(); } return dialog.accept(); });
    await page.goto(`${isolated.origin}/?clientId=${clientId}`, { waitUntil: "commit" });
    const earlyPicker = page.locator("#client-picker > .client-picker-summary");
    await earlyPicker.click();
    assert.equal(await earlyPicker.getAttribute("aria-expanded"), "false", "A pre-hydration click must not mutate native open state");
    releaseScripts();
    await page.locator('main[data-panel-ready="true"]').waitFor();
    const profile = page.locator("#deploy-profile-editor"), brand = profile.getByLabel("Название бренда", { exact: true });
    const save = profile.getByRole("button", { name: "Сохранить поля", exact: true });
    await brand.waitFor();
    assert.equal(await page.locator("#client-card").getByRole("link", { name: "Сайт на хосте", exact: true }).getAttribute("href"), new URL(details.get(clientId).profile.hostUrl).href);
    assert.equal(await page.getByRole("button", { name: "Развертывание еще не подключено", exact: true }).count(), 0);
    const picker = page.locator("#client-picker"), pickerSummary = picker.locator(":scope > .client-picker-summary");
    const pickerSearch = picker.getByLabel("Поиск клиента", { exact: true });
    assert.equal(await pickerSummary.getAttribute("aria-expanded"), "false");
    const collapsedClientCardY = (await page.locator("#client-card").boundingBox()).y;
    assert.ok(collapsedClientCardY < 700, "Selected client must appear without scrolling past all other client cards");
    await page.screenshot({ path: path.join(output, "client-collapsed.png"), caret: "initial" });
    await pickerSummary.focus(); await pickerSummary.press("Enter");
    await pickerSearch.fill("no-matching-client-fixture");
    await picker.getByText("Клиенты не найдены. Измените запрос или сбросьте поиск.", { exact: true }).waitFor();
    assert.equal(await picker.locator(".client-card-button").count(), 0);
    await picker.getByRole("button", { name: "Сбросить поиск", exact: true }).click();
    await page.waitForFunction((count) => document.querySelectorAll("#client-picker .client-card-button").length === count, dashboard.clients.length);
    await pickerSearch.fill(details.get(otherId).client.domain);
    await page.waitForFunction(() => document.querySelectorAll("#client-picker .client-card-button").length === 1);
    assert.equal(await picker.locator(".client-card-button").getAttribute("data-client-id"), otherId);
    await page.screenshot({ path: path.join(output, "client-picker-filter.png"), caret: "initial" });
    async function chooseClient(id) {
      if (await pickerSummary.getAttribute("aria-expanded") === "false") await pickerSummary.click();
      await pickerSearch.fill(details.get(id).client.domain);
      await picker.locator(`.client-card-button[data-client-id="${id}"]`).click();
    }
    const originalBrand = await brand.inputValue();
    await brand.fill("Cancelled switch draft");
    dismissNextDialog = true;
    await chooseClient(otherId);
    assert.equal(new URL(page.url()).searchParams.get("clientId"), clientId);
    assert.equal(await brand.inputValue(), "Cancelled switch draft");
    assert.equal(await pickerSummary.getAttribute("aria-expanded"), "true");
    await brand.fill(originalBrand);
    await pickerSummary.click();
    await brand.fill("Discardable fixture draft");
    const discard = profile.getByRole("button", { name: "Отменить правки", exact: true });
    dismissNextDialog = true; await discard.click();
    assert.equal(await brand.inputValue(), "Discardable fixture draft");
    await discard.click();
    await profile.locator(".draft-note").waitFor({ state: "hidden" });
    assert.equal(await brand.inputValue(), originalBrand);
    assert.equal(calls.length, 0, "Discarding only local unsaved fields must not write to backend");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.locator("body").evaluate((body) => ({ width: body.clientWidth, scroll: body.scrollWidth }));
    assert.ok(mobile.scroll <= mobile.width + 1);
    await pickerSummary.focus(); await pickerSummary.press("Enter");
    await pickerSearch.fill("");
    await page.waitForFunction((count) => document.querySelectorAll("#client-picker .client-card-button").length === count, dashboard.clients.length);
    const listBounds = await picker.locator(".client-picker-list").evaluate((list) => ({ height: list.clientHeight, scroll: list.scrollHeight, bar: getComputedStyle(list).scrollbarWidth }));
    assert.ok(listBounds.height <= 440 && listBounds.scroll > listBounds.height);
    assert.equal(listBounds.bar, "none");
    await page.screenshot({ path: path.join(output, "client-picker-mobile.png"), caret: "initial" });
    await pickerSummary.click();
    await page.setViewportSize({ width: 1500, height: 1000 });
    assert.equal(calls.length, 0, "Choosing and filtering clients must not issue write commands");
    await brand.fill("Submitted fixture");
    holdCommand = "update-deploy-profile";
    await save.click();
    while (!releaseCommand) await new Promise((resolve) => setTimeout(resolve, 10));
    await brand.fill("Newer retained fixture");
    assert.equal(await profile.getByRole("button", { name: "Сохранение...", exact: true }).isDisabled(), true);
    assert.equal(calls.filter((command) => command === "update-deploy-profile").length, 1);
    holdCommand = null; releaseCommand(); releaseCommand = null;
    await profile.locator(".message-success").filter({ hasText: "Профиль сохранен" }).waitFor();
    await save.waitFor();
    assert.equal(await brand.inputValue(), "Newer retained fixture");
    await save.click();
    await profile.locator(".draft-note").waitFor({ state: "hidden" });
    assert.equal(await brand.inputValue(), "Newer retained fixture");
    failCommand = "update-deploy-profile";
    await brand.fill("Kept after failure"); await save.click();
    await profile.locator(".message-error").waitFor();
    assert.equal(await brand.inputValue(), "Kept after failure");
    assert.ok(!(await profile.locator(".message-error").innerText()).includes("private"));
    failCommand = null; malformedCommand = "update-deploy-profile"; await save.click();
    await profile.locator(".message-error").waitFor();
    assert.equal(await brand.inputValue(), "Kept after failure");
    malformedCommand = null; await save.click();
    await profile.locator(".draft-note").waitFor({ state: "hidden" });
    holdCommand = "update-deploy-profile";
    await brand.fill("Kept after timed out write");
    const timeoutStarted = Date.now(); await save.click();
    await profile.locator(".message-error").waitFor({ timeout: 25000 });
    const writeTimeoutMs = Date.now() - timeoutStarted;
    assert.equal(await brand.inputValue(), "Kept after timed out write");
    assert.equal(await save.isEnabled(), true);
    // The backend may still finish after a timeout; confirm the in-memory result before the next command.
    holdCommand = null; if (releaseCommand) { releaseCommand(); releaseCommand = null; }
    await save.click(); await profile.locator(".draft-note").waitFor({ state: "hidden" });
    holdCommand = "update-deploy-profile";
    await save.click();
    const staleWait = Date.now() + 5000;
    while (!releaseCommand) { if (Date.now() > staleWait) throw new Error("Stale client request was not started"); await new Promise((resolve) => setTimeout(resolve, 10)); }
    const releaseOldClient = releaseCommand; releaseCommand = null;
    const otherName = details.get(otherId).client.name;
    await chooseClient(otherId);
    await page.locator(".operator-cockpit-main > strong").filter({ hasText: otherName }).waitFor();
    const otherBrand = await brand.inputValue();
    await save.click();
    const newWait = Date.now() + 5000;
    while (!releaseCommand) { if (Date.now() > newWait) throw new Error("New client request remained incorrectly blocked"); await new Promise((resolve) => setTimeout(resolve, 10)); }
    releaseOldClient();
    assert.equal(await profile.getByRole("button", { name: "Сохранение...", exact: true }).isDisabled(), true);
    assert.equal(await brand.inputValue(), otherBrand);
    holdCommand = null; releaseCommand(); releaseCommand = null;
    await save.waitFor();
    await chooseClient(clientId);
    await page.locator(".operator-cockpit-main > strong").filter({ hasText: details.get(clientId).client.name }).waitFor();
    await profile.getByRole("button", { name: "Вернуть в черновик", exact: true }).click();
    await profile.getByRole("button", { name: "Отметить как проверено", exact: true }).waitFor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#deploy-profile-editor button")).find((button) => button.textContent === "Отметить как проверено")?.disabled === false);
    await profile.getByRole("button", { name: "Отметить как проверено", exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#deploy-profile-editor button")).find((button) => button.textContent === "Подготовить к деплою")?.disabled === false);
    await profile.getByRole("button", { name: "Подготовить к деплою", exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#deploy-profile-editor button")).find((button) => button.textContent === "Подготовить локальный пакет")?.disabled === false);
    await profile.getByRole("button", { name: "Подготовить локальный пакет", exact: true }).click();
    await profile.locator(".message-success").filter({ hasText: "Локальный пакет подготовлен" }).waitFor();
    await page.getByRole("button", { name: "Мониторинг", exact: true }).click();
    failCommand = "validate-client"; await page.getByRole("button", { name: "Запустить проверку", exact: true }).click();
    await page.locator("#client-validation .message-error").waitFor();
    failCommand = null; await page.getByRole("button", { name: "Запустить проверку", exact: true }).click();
    await page.locator("#client-validation .message-success").waitFor();
    await page.locator("#client-health > summary").click();
    failCommand = "run-health-check"; await page.getByRole("button", { name: "Повторить проверку сервисов", exact: true }).click();
    await page.locator("#client-health .message-error").waitFor();
    failCommand = null; await page.getByRole("button", { name: "Повторить проверку сервисов", exact: true }).click();
    await page.locator("#client-health .message-success").waitFor();
    await page.getByRole("button", { name: "Карточка клиента", exact: true }).click();
    await brand.fill("Retained during RSC failure");
    failDashboard = true;
    // A saved-profile response triggers a real router refresh; the following server read intentionally fails.
    await save.click();
    await page.getByRole("button", { name: "Повторить загрузку данных", exact: true }).waitFor();
    assert.equal(await brand.inputValue(), "Retained during RSC failure");
    assert.equal(await save.isDisabled(), true);
    failDashboard = false;
    await page.getByRole("button", { name: "Повторить загрузку данных", exact: true }).click();
    await page.locator(".system-warning-card").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Мастер создания", exact: true }).click();
    const wizard = page.locator("#client-editor");
    await wizard.getByLabel("Email администратора клиента", { exact: true }).fill("kept-email@example.invalid");
    await wizard.getByLabel("Логин администратора клиента", { exact: true }).fill("independent.login");
    assert.equal(await wizard.getByLabel("Email администратора клиента", { exact: true }).inputValue(), "kept-email@example.invalid");
    await wizard.getByLabel("Email администратора клиента", { exact: true }).fill("changed-email@example.invalid");
    assert.equal(await wizard.getByLabel("Логин администратора клиента", { exact: true }).inputValue(), "independent.login");
    const wizardLayouts = [];
    for (const width of [1500, 900, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const grid = await wizard.locator(".form-grid").first().evaluate((grid) => ({ columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length, width: grid.clientWidth, scroll: grid.scrollWidth }));
      assert.equal(grid.columns, width === 1500 ? 3 : width === 900 ? 2 : 1);
      assert.ok(grid.scroll <= grid.width + 1);
      wizardLayouts.push({ viewportWidth: width, ...grid });
      const login = await wizard.getByLabel("Логин администратора клиента", { exact: true }).boundingBox(), password = await wizard.getByLabel("Пароль администратора клиента", { exact: true }).boundingBox();
      if (width > 700) assert.ok(Math.abs(login.y - password.y) < 1, "Admin login/password must share a row");
      if (width === 900) await page.screenshot({ path: path.join(output, "wizard-readable-900.png"), caret: "initial" });
    }
    await page.setViewportSize({ width: 1500, height: 1000 });
    await wizard.getByLabel("Название клиента", { exact: true }).fill("Unsent wizard fixture");
    await page.getByRole("button", { name: "Карточка клиента", exact: true }).click();
    await page.getByRole("button", { name: "Мастер создания", exact: true }).click();
    assert.equal(await wizard.getByLabel("Название клиента", { exact: true }).inputValue(), "Unsent wizard fixture");
    const fields = { "Код клиента (slug)": "acceptance-not-real", "Домен": "acceptance.invalid", "Название бренда": "Fixture brand", "Логин администратора клиента": "fixture.admin", "Email администратора клиента": "fixture@example.invalid", "Имя": "Fixture", "Пароль администратора клиента": "fixture-not-real-password", "Логин системного администратора": "fixture.system", "Пароль системного администратора": "fixture-not-real-system-password", "Адрес LMS хоста": "http://127.0.0.1:1", "Хост базы данных": "127.0.0.1", "Имя базы данных": "acceptance_fixture", "Пользователь базы": "acceptance_fixture", "Бакет storage": "acceptance-fixture" };
    for (const [label, value] of Object.entries(fields)) await wizard.getByLabel(label, { exact: true }).fill(value);
    holdCommand = "bootstrap-client";
    await wizard.getByRole("button", { name: "Создать клиентский пакет", exact: true }).click();
    const createWait = Date.now() + 5000;
    while (!releaseCommand) { if (Date.now() > createWait) throw new Error("Wizard did not submit: required fields or client errors"); await new Promise((resolve) => setTimeout(resolve, 10)); }
    await wizard.getByLabel("Название клиента", { exact: true }).fill("Newer wizard draft");
    assert.equal(await wizard.getByRole("button", { name: "Создание...", exact: true }).isDisabled(), true);
    holdCommand = null; releaseCommand(); releaseCommand = null;
    await wizard.locator(".message-success").filter({ hasText: "Более новый ввод остался" }).waitFor();
    assert.equal(await wizard.getByLabel("Название клиента", { exact: true }).inputValue(), "Newer wizard draft");
    assert.equal(await wizard.getByLabel("Пароль администратора клиента", { exact: true }).inputValue(), "");
    assert.equal(await wizard.getByLabel("Пароль системного администратора", { exact: true }).inputValue(), "");
    assert.equal(calls.filter((command) => command === "bootstrap-client").length, 1);
    assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
    for (const command of ["bootstrap-client", "update-deploy-profile", "mark-draft", "mark-validated", "mark-ready-to-deploy", "run-deploy", "validate-client", "run-health-check"]) assert.ok(calls.includes(command));
    const result = { checkedAt: new Date().toISOString(), realProductionUiAndProxy: true, buildMs: isolated.buildMs, inMemoryBackendOnly: true, realBackendWrites: 0, duplicateWritesBlocked: true, newerProfileInputRetained: true, staleClientResponseIsolated: true, errorsPreserveDraft: true, writeTimeoutMs, timeoutRecovers: true, workflowAndPackage: true, validationAndHealthFailureRecovery: true, rscFailureRetainsClientAndForm: true, wizardDraftSurvivesTabs: true, newerWizardInputSurvivesCreatedResponse: true, submittedPasswordsCleared: true, commandCounts: Object.fromEntries([...new Set(calls)].map((command) => [command, calls.filter((item) => item === command).length])), errors, unexpectedRequests };
    await page.screenshot({ path: path.join(output, "wizard-retained.png"), caret: "initial" });
    Object.assign(result, { compactSearchableClientPicker: true, collapsedClientCardY, cancelledSwitchRetainsDraft: true, mobilePicker: mobile });
    result.confirmedLocalDraftDiscardWithoutWrites = true;
    assert.deepEqual(hydrationErrors, []);
    Object.assign(result, { earlyClickBeforeScriptsAccepted: true, hydrationErrors });
    result.publicWebsiteUrlExcludesFilesystemPath = true;
    Object.assign(result, { independentAdminLoginAndEmail: true, wizardLayouts });
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, output }));
  } finally {
    if (releaseScripts) releaseScripts();
    if (releaseCommand) releaseCommand();
    if (browser) await browser.close();
    if (isolated) await isolated.cleanup();
    backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve));
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
