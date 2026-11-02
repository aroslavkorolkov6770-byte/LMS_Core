const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const clientId = process.env.CORE_PREVIEW_CLIENT_ID || "ffe5afda-f49c-4518-9dea-429dca1dbf1e";
const output = path.join(root, "infra/runtime/local-acceptance/preview-save-20261029", randomUUID());

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [], unexpectedMutations = [], mockedWrites = [];
    let settingsMode = "hold", releaseSettings, settingsCount = 0;
    let routeTitle = "Local acceptance fixture", testsFail = true;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await context.route(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\//, async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === "POST" && url.pathname === "/api/preview-settings") {
        settingsCount++;
        mockedWrites.push("settings");
        const submitted = request.postDataJSON();
        const { clientId: _clientId, ...settings } = submitted;
        if (settingsMode === "hold") await new Promise((resolve) => { releaseSettings = resolve; });
        if (settingsMode === "timeout") { await new Promise((resolve) => setTimeout(resolve, 16500)); return route.abort().catch(() => {}); }
        if (settingsMode === "fail") return route.fulfill({ status: 503, json: { message: "Local acceptance failure" } });
        return route.fulfill({ status: 200, json: { clientId, settings } });
      }
      if (url.pathname === "/api/storage" && url.searchParams.get("keys") === "core_lms_route_v1,core_lms_tests_v1") {
        return route.fulfill({ status: 200, json: { core_lms_route_v1: [{ id: "acceptance-only-not-persisted", title: routeTitle, section: "Acceptance", h1: "Fixture", t1: "No production materials." }], core_lms_tests_v1: [] } });
      }
      if (url.pathname === "/api/storage" && request.method() === "POST") {
        const submitted = request.postDataJSON();
        assert.ok(["core_lms_route_v1", "core_lms_tests_v1"].includes(submitted.key));
        mockedWrites.push(submitted.key);
        if (submitted.key === "core_lms_route_v1") routeTitle = submitted.data[0].title;
        return route.fulfill({ status: testsFail && submitted.key === "core_lms_tests_v1" ? 503 : 200, json: { success: !(testsFail && submitted.key === "core_lms_tests_v1") } });
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) { unexpectedMutations.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:3100/preview?clientId=${encodeURIComponent(clientId)}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator(".frame-status").filter({ hasText: "Готово" }).waitFor({ timeout: 45000 });
    const title = page.locator(".field").filter({ has: page.locator("label", { hasText: /^Главный заголовок$/ }) }).locator("input");
    const save = page.locator(".top-actions button.primary-action");
    await title.fill("Submitted version");
    await save.click();
    await page.waitForFunction(() => document.querySelector(".top-actions button.primary-action")?.disabled === true);
    while (!releaseSettings) await new Promise((resolve) => setTimeout(resolve, 10));
    await title.fill("Newer unsaved version");
    assert.equal(await save.isDisabled(), true, "Typing must not unlock a second write while the first is pending");
    assert.equal(settingsCount, 1);
    releaseSettings();
    await page.locator(".save-message").filter({ hasText: "Более новые правки остались" }).waitFor();
    assert.equal(await title.inputValue(), "Newer unsaved version");
    settingsMode = "success";
    await save.click();
    await page.locator(".save-message.saved").waitFor();
    assert.equal(await title.inputValue(), "Newer unsaved version");
    settingsMode = "fail";
    await title.fill("Preserved on rejection");
    await save.click();
    await page.locator(".save-message.error").filter({ hasText: "Сервер не подтвердил" }).waitFor();
    assert.equal(await title.inputValue(), "Preserved on rejection");
    settingsMode = "timeout";
    const timeoutStarted = Date.now();
    await save.click();
    await page.locator(".save-message.error").filter({ hasText: "Подтверждение сохранения не получено" }).waitFor({ timeout: 25000 });
    const timeoutMs = Date.now() - timeoutStarted;
    assert.equal(await save.isEnabled(), true);
    assert.equal(await title.inputValue(), "Preserved on rejection");
    settingsMode = "success";
    await save.click();
    await page.locator(".save-message.saved").waitFor();
    await page.locator(".inspector-tabs").getByRole("button", { name: "Учеба", exact: true }).click();
    const lessonTitle = page.locator(".field").filter({ has: page.locator("label", { hasText: /^Название карточки урока$/ }) }).locator("input");
    await lessonTitle.waitFor();
    await lessonTitle.fill("Changed local fixture");
    await page.getByRole("button", { name: "Сохранить учебу", exact: true }).click();
    await page.locator(".learning-content-status.error").filter({ hasText: "Уроки сохранены. Сохранение тестов не подтверждено" }).waitFor();
    assert.equal(await lessonTitle.inputValue(), "Changed local fixture");
    assert.equal(await page.getByRole("button", { name: "Откатить", exact: true }).isDisabled(), true, "Confirmed lesson snapshot must be retained after the second request failed");
    assert.deepEqual(unexpectedMutations, []);
    assert.deepEqual(errors, []);
    assert.equal(settingsCount, 5);
    const result = { checkedAt: new Date().toISOString(), realNextUi: true, mockedBackendWritesOnly: true, actualBackendWrites: 0, duplicateSaveBlocked: true, newTypingSurvivesResponse: true, rejectionPreservesDraft: true, timeoutMs, timeoutRetryRecovers: true, partialLearningSaveReportedHonestly: true, mockedWrites, unexpectedMutations, errors };
    await page.screenshot({ path: path.join(output, "partial-save.png"), caret: "initial" });
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, output }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
