const { chromium } = require("playwright");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

// This isolated UI test uses a mock bridge. It never invokes real services or GitHub.
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: true
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const deploymentStep = async (stage) => page.locator(`[data-deploy-stage="${stage}"]`).click();
    const remotePassword = async (value) => { await deploymentStep("connection"); await page.locator("#remote-password").fill(value); };
    if (process.env.CORE_TEST_STORAGE_FAULT === "1") page.setDefaultTimeout(5000);
    let networkWrites = 0;
    await page.route(/^http:\/\/127\.0\.0\.1:/, (route) => {
      if (process.env.CORE_TEST_CARD_ACCESS === "1" && new URL(route.request().url()).port === "3002") {
        if (route.request().method() === "GET") return route.continue();
        networkWrites++; return route.fulfill({ status: 403, contentType: "application/json", body: '{"message":"Fixture blocks all real writes"}' });
      }
      return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Isolated iframe fixture</title><input aria-label="Fixture draft"><script>
      window.fixtureDocumentId=crypto.randomUUID(); let fixtureSession='';
      addEventListener('message',event=>{
        if(event.source!==parent)return;
        const data=event.data;
        if(data?.type==='lms-core:client-context'){fixtureSession=data.session;window.fixtureContextReady=true;}
        if(data?.type==='lms-core:panel-state-request'&&data.session===fixtureSession&&!window.fixtureIgnoreState)setTimeout(()=>parent.postMessage({type:'lms-core:panel-state',version:1,session:fixtureSession,requestId:data.requestId,clientId:new URL(location.href).searchParams.get('clientId'),dirty:window.fixtureDirty===true,busy:window.fixtureBusy===true,blocked:false},'*'),window.fixtureStateDelay||0);
      });
      addEventListener('DOMContentLoaded',()=>parent.postMessage({type:'lms-core:client-context-ready',version:1},'*'));
    </script>` }); });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(({ storageFault, frameLifecycle, performanceMode, savedServers }) => {
      if (window.top !== window) return;
      localStorage.clear();
      const statuses = [
        { id: "postgres", label: "PostgreSQL", kind: "postgres", port: 55432, url: "", running: false },
        { id: "api", label: "Backend API", kind: "pnpm", port: 3001, url: "", running: false },
        { id: "lms-web", label: "LMS Runtime", kind: "pnpm", port: 3217, url: "", running: false },
        { id: "deploy-panel", label: "Deploy Panel", kind: "pnpm", port: 3002, url: "", running: false }
      ];
      if (frameLifecycle) statuses.forEach((status) => Object.assign(status, { running: true, healthState: "healthy", ok: true }));
      const blank = { config: { url: "", branch: "", identityMode: "default", identityFile: "" }, result: null, key: { available: false, publicKey: "", fingerprint: "" } };
      window.testCalls = { startAll: 0, repositoryChecks: 0, lastRepository: null };
      window.testTargetMode = "ok";
      window.testSourceLibrary = { version: 1, revision: 0, sources: [] };
      window.testStatuses = statuses;
      window.testIntervals = [];
      const originalInterval = window.setInterval;
      window.setInterval = (callback, delay, ...args) => { window.testIntervals.push({ callback, delay }); return originalInterval.call(window, callback, delay, ...args); };
      let firstLog = true;
      const initialLog = new Promise((resolve) => { window.releaseInitialLog = resolve; });
      const emptySource = { phase: "idle", message: "Код из Git еще не получен.", snapshot: null };
      const startupRead = (key, value) => {
        if (!performanceMode) return Promise.resolve(value);
        (window.testStartupCalls ||= []).push(key);
        return new Promise(resolve => { (window.testStartupRelease ||= {})[key] = () => resolve(value); });
      };
      window.launcherApi = {
        recoverInstallation: async (clientId, target, credentials) => {
          window.testCalls.recovery = { clientId, authenticated: credentials.password === "fixture-password" };
          return window.testSavedInstallation = { ...window.testSavedInstallation, phase: "failed", retryAvailable: false, errorCode: "INSTALLATION_RETRY_READY", message: "Подготовка архивирована, можно повторить установку.", updatedAt: new Date().toISOString() };
        },
        deleteClient: async (clientId) => {
          window.testCalls.clientDelete = (window.testCalls.clientDelete || 0) + 1;
          if (window.testClientDeleteMode === "cancel") return { phase: "cancelled", clientId };
          if (window.testClientDeleteMode === "fail") throw Error("Fixture SSH disconnected; карточка сохранена");
          if (window.testClientDeleteMode === "wait") return new Promise(resolve => { window.resolveClientDelete = () => resolve({ phase: "deleted", clientId }); });
          return { phase: "deleted", clientId };
        },
        onClientDeletionProgress: (callback) => { window.testClientDeleteProgress = callback; return () => {}; },
        ping: async () => ({ ok: true, timestamp: "fixture" }),
        getWindowVisibility: async () => startupRead("visibility", true),
        onWindowVisibility: (callback) => { window.testNativeVisibility = callback; return () => {}; },
        getLauncherLogPath: async () => "C:\\fixture\\launcher.log",
        getStatuses: async (options) => { window.testCalls.statusReads = (window.testCalls.statusReads || 0) + 1; window.testCalls.lastStatusFresh = options?.fresh === true; return statuses; },
        getConfig: async () => startupRead("config", { services: statuses }),
        getInterfacePreferences: async (legacy) => startupRead("preferences", { preferences: legacy, warning: "" }),
        saveInterfacePreferences: async (preferences) => {
          if (window.testFailPreferences) throw new Error("Fixture disk failure");
          window.testCalls.savedPreferences = { ...preferences };
          return preferences;
        },
        getRepository: async () => blank,
        getSourceLibrary: async () => JSON.parse(JSON.stringify(window.testSourceLibrary)),
        saveSourceLibraryEntry: async (input, revision) => {
          if (window.testFailSourceSave) throw Error("Fixture write failure");
          if (revision !== window.testSourceLibrary.revision) throw Error("Fixture revision conflict");
          const state = window.testSourceLibrary, index = state.sources.findIndex((entry) => entry.id === input.id);
          const entry = { ...input, id: input.id || crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          if (index >= 0) state.sources[index] = entry; else state.sources.push(entry);
          state.revision++; return JSON.parse(JSON.stringify(state));
        },
        getRemoteTarget: async () => ({ host: "fixture.example", port: 22, username: "root", basePath: "/srv/lms-core/clients", fingerprint: "" }),
        getRemoteState: async () => ({ target: { host: "fixture.example", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/var/www/fixture", fingerprint: "" }, inventory: null, preflight: null }),
        saveRemoteTarget: async (target) => target,
        probeRemoteTarget: async () => ({ fingerprint: "SHA256:" + "A".repeat(43) }),
        inspectRemoteTarget: async (target, credentials) => {
          window.testCalls.remoteInspected = target.host === "fixture.example" && credentials.password === "fixture-password";
          return { os: "Ubuntu fixture", user: "root", node: "v24.fixture", npm: "11.fixture", postgres: "active", mysql: "inactive", mariadb: "inactive", projectPaths: ["/srv/fixture/package.json"] };
        },
        preflightRemoteTarget: async (target, credentials) => {
          if (window.testFailRemotePreflight) throw Error("Fixture SSH unavailable");
          window.testCalls.preflightChecked = target.appPath === "/var/www/fixture" && credentials.password === "fixture-password";
          return { checkedAt: "2026-10-28T13:00:00.000Z", appRoot: target.appPath, backend: "json", projectKind: "nextjs", packageManager: "npm",
            protectedPaths: [{ bytes: 1000 }], environmentFiles: ["/var/www/fixture/.env"], managers: { pm2: [{ name: "fixture", status: "online" }], systemd: [] },
            diskFreeBytes: 5 * 1024 ** 3, memoryTotalBytes: 2 * 1024 ** 3, warnings: ["Fixture backup required"] };
        },
        getSourceState: async () => emptySource,
        getGitPreview: async () => ({ phase: "idle", message: "Запустите локальный просмотр выбранной Git-версии." }),
        onGitPreviewState: (callback) => { window.testGitPreviewState = callback; return () => {}; },
        startGitPreview: async (clientId, snapshotId) => { window.testCalls.gitPreviewStart = { clientId, snapshotId }; },
        stopGitPreview: async () => { window.testCalls.gitPreviewStopped = true; window.testGitPreviewState({ phase: "stopped", message: "Просмотр остановлен" }); },
        showGitPreview: async () => { window.testCalls.gitPreviewShown = true; },
        layoutGitPreview: async (bounds) => { window.testCalls.gitPreviewBounds = bounds; },
        reloadGitPreview: async () => { window.testCalls.gitPreviewReloaded = true; },
        loginGitPreview: async (role) => { window.testCalls.gitPreviewRole = role; },
        getInstallationPlan: async () => null,
        getInstallationState: async () => window.testSavedInstallation || null,
        getUninstallation: async () => ({ state: window.testRemovalState || null, accepted: true }),
        prepareUninstallation: async (clientId, target, credentials) => {
          window.testCalls.removalChecked = credentials.password === "fixture-password";
          window.testRemovalState = { version: 2, mode: "full", clientId, operationId: "fixture-removal", jobId: "fixture-new-job", releaseId: "fixture-release", target, appPath: "/srv/lms-core/clients/fixture", phase: "checked", archiveCompleted: false, checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), preserveData: false };
          return window.testRemovalState;
        },
        executeUninstallation: async (clientId, operationId, target, credentials) => {
          window.testCalls.removalExecuted = { clientId, operationId, authenticated: credentials.password === "fixture-password" };
          if (window.testRemovalCancel) throw Error("Удаление отменено; сервер не изменен.");
          const result = { ...window.testRemovalState, phase: window.testRemovalFailure ? "failed" : "uninstalled", archiveCompleted: !window.testRemovalFailure, databaseDeleted: !window.testRemovalFailure, serviceAccountDeleted: !window.testRemovalFailure, certificatesArchived: !window.testRemovalFailure, backupPath: "/srv/lms-core/backups/fixture/fixture-removal", rollbackRestored: window.testRemovalFailure, updatedAt: new Date().toISOString() };
          window.testRemovalState = result; if (!window.testRemovalFailure) window.testSavedInstallation = null; return result;
        },
        refreshUninstallation: async () => window.testRemovalState,
        getAiConfiguration: async () => window.testSavedAi || null,
        getMailConfiguration: async () => window.testSavedMail || null,
        configureLmsMail: async (clientId, target, credentials, action, settings, recipient) => {
          window.testCalls.mail = { clientId, action, authenticated: credentials.password === "fixture-password", passwordMatches: settings.SMTP_PASS === "fixture-smtp-secret", recipient };
          if (window.testMailCancel) throw Error("Настройка почты отменена; сервер и получатель не изменены.");
          const publicFields = action === "apply" ? Object.fromEntries(["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER"].map(key => [key, settings[key]])) : Object.fromEntries(["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER"].map(key => [key, window.testSavedMail?.[key] || ""]));
          const state = { clientId, jobId: "fixture-new-job", releaseId: window.testSavedInstallation?.releaseId, host: target.host, ...publicFields,
            supportContactReady: true, supportEmail: publicFields.SMTP_USER,
            phase: action === "check" ? "checked" : window.testMailFailure ? action === "test" ? "test_failed" : "failed" : action === "test" ? "test_sent" : "applied",
            passwordPresent: true, configured: true, smtpVerified: action === "test" && !window.testMailFailure, updatedAt: new Date().toISOString(),
            ...(action === "test" ? { testRecipient: recipient } : {}), ...(window.testMailFailure ? { errorCode: action === "test" ? "MAIL_AUTH_FAILED" : "MAIL_CHANGE_ROLLED_BACK", rollbackRestored: action !== "test" } : {}) };
          if (action === "apply" && !window.testMailFailure) window.testSavedMail = state;
          return state;
        },
        configureLmsAi: async (clientId, target, credentials, settings, checkOnly) => {
          window.testCalls.ai = { clientId, authenticated: credentials.password === "fixture-password", checkOnly, tokenMatches: settings.AI_API_KEY === "fixture-ai-secret", fields: [settings.AI_PROJECT_ID, settings.AI_PROMPT_ID, settings.AI_VECTOR_STORE_ID] };
          if (window.testAiCancel) throw Error("Настройка ИИ отменена; сервер не изменён.");
          const state = { clientId, jobId: "fixture-new-job", releaseId: window.testSavedInstallation?.releaseId, host: target.host, phase: checkOnly ? "checked" : window.testAiFailure ? "failed" : "applied", apiKeyPresent: !window.testAiFailure && (!checkOnly || Boolean(window.testSavedAi?.apiKeyPresent)), configured: !window.testAiFailure && (!checkOnly || Boolean(window.testSavedAi?.configured)), providerVerified: false,
            AI_PROJECT_ID: checkOnly ? window.testSavedAi?.AI_PROJECT_ID || "" : settings.AI_PROJECT_ID, AI_PROMPT_ID: checkOnly ? window.testSavedAi?.AI_PROMPT_ID || "" : settings.AI_PROMPT_ID, AI_VECTOR_STORE_ID: checkOnly ? window.testSavedAi?.AI_VECTOR_STORE_ID || "" : settings.AI_VECTOR_STORE_ID, updatedAt: new Date().toISOString(), ...(window.testAiFailure ? { rollbackRestored: true, errorCode: "AI_CHANGE_ROLLED_BACK" } : {}) };
          if (!checkOnly && !window.testAiFailure) window.testSavedAi = state;
          return state;
        },
        provisionLmsAi: async (clientId, target, credentials, settings) => {
          window.testCalls.aiProvision = { clientId, authenticated: credentials.password === "fixture-password", tokenEmpty: !settings.AI_API_KEY, suppliedVector: settings.AI_VECTOR_STORE_ID };
          if (window.testAiCancel) throw Error("Настройка ИИ отменена; ресурсы не создавались.");
          const state = { clientId, jobId: "fixture-new-job", releaseId: window.testSavedInstallation?.releaseId, host: target.host, phase: "applied", apiKeyPresent: true, configured: true, providerVerified: false,
            AI_PROJECT_ID: settings.AI_PROJECT_ID, AI_PROMPT_ID: settings.AI_PROMPT_ID, AI_VECTOR_STORE_ID: "fixture-auto-index", indexId: "fixture-auto-index", indexReused: Boolean(window.testSavedAi?.indexId), provisionMode: "core_vector_store", updatedAt: new Date().toISOString() };
          window.testSavedAi = state; return state;
        },
        getIpPublication: async () => window.testSavedPublication || null,
        publishLmsIp: async (clientId, target, credentials, checkOnly) => {
          window.testCalls.ipPublication = { clientId, host: target.host, authenticated: credentials.password === "fixture-password", checkOnly };
          const result = checkOnly && window.testSavedPublication ? { ...window.testSavedPublication, updatedAt: new Date().toISOString() } : { clientId, jobId: "fixture-new-job", host: target.host, phase: "succeeded", url: `http://${target.host}`, updatedAt: new Date().toISOString() };
          window.testSavedPublication = result; return result;
        },
        enableLmsIpHttps: async (clientId, target, credentials) => {
          window.testCalls.https = { clientId, host: target.host, authenticated: credentials.password === "fixture-password" };
          if (window.testHttpsCancel) throw Error("HTTPS отменен; сервер не изменен.");
          if (window.testHttpsWait) await new Promise(resolve => { window.testHttpsRelease = resolve; });
          if (window.testHttpsFail) return { clientId, jobId: "fixture-new-job", host: target.host, phase: "failed", protocol: "http", errorCode: "ACME_WEBROOT_UNREACHABLE", rollback: true, updatedAt: new Date().toISOString() };
          const result = { clientId, jobId: "fixture-new-job", host: target.host, phase: "succeeded", protocol: "https", url: `https://${target.host}`, autoRenew: true, renewalState: "scheduled", expiresAt: new Date(Date.now() + 160 * 3600000).toISOString(), updatedAt: new Date().toISOString() };
          window.testSavedPublication = result; return result;
        },
        getExecutionMode: async () => "local",
        setExecutionMode: async (mode) => mode,
        getServerPreparation: async () => null,
        prepareCleanServer: async (clientId, planId, target, credentials) => {
          window.testCalls.preparedClean = credentials.password === "fixture-password";
          return { clientId, phase: "succeeded", message: "Окружение готово (mock)." };
        },
        prepareServerMemory: async (clientId, planId, target, credentials) => {
          window.testCalls.preparedMemory = credentials.password === "fixture-password";
          return { ok: true, created: true, message: "Память готова: fixture swap 4 ГиБ." };
        },
        onPreparationProgress: () => () => {},
        onLmsViewerState: () => () => {},
        layoutLmsViewer: async (bounds) => { window.testCalls.viewerBounds = bounds; window.testCalls.viewerLayouts = (window.testCalls.viewerLayouts || 0) + 1; },
        openLmsViewer: async (clientId, target, credentials) => {
          window.testCalls.viewerOpened = credentials.password === "fixture-password";
          return { phase: "open", clientId, url: "http://127.0.0.1:23000", message: "LMS открыта (mock)." };
        },
        closeLmsViewer: async () => ({ phase: "closed", message: "Соединение закрыто (mock)." }),
        onInstallationProgress: (callback) => { window.testInstallationProgress = callback; return () => {}; },
        prepareInstallationPackage: async (clientId, planId, snapshotId) => {
          const mode = window.testCalls.installationPrepared.contentMode;
          window.testNewPackage = { id: "fixture-package", revision: "a".repeat(40), archiveBytes: 9000000, contentMode: mode,
            ...(mode === "source" ? { curriculum: { revision: "a".repeat(40), sha256: "c".repeat(64), topics: 25, tests: 9, questions: 89 } } : {}) };
          const plan = await window.launcherApi.prepareInstallation(clientId, snapshotId, window.testCalls.installationPrepared.target, mode);
          return { ...plan, status: "needs_server_check", package: window.testNewPackage, checks: [] };
        },
        startInstallation: async (clientId, planId, snapshotId, target, credentials, secrets) => {
          window.testCalls.newStarted = { clientId, authenticated: credentials.password === "fixture-password", database: secrets.maintenanceUrl.includes("fixture-db-password"), admins: secrets.clientAdminPassword === "fixture-client-password" && secrets.systemAdminPassword === "fixture-system-password" };
          const state = { id: "fixture-new-job", clientId, target, revision: "a".repeat(40), phase: "build", message: "Fixture NEW build", updatedAt: new Date().toISOString(), webPort: 3000 };
          window.testInstallationProgress?.(state);
          await new Promise((resolve) => setTimeout(resolve, 100));
          window.testSavedInstallation = { ...state, phase: "succeeded", message: "Fixture NEW succeeded" };
          return window.testSavedInstallation;
        },
        refreshInstallation: async (clientId, target) => ({ id: "fixture-new-job", clientId, target, revision: "a".repeat(40), phase: "succeeded", message: "Fixture NEW checked", updatedAt: new Date().toISOString(), webPort: 3000 }),
        prepareInstallation: async (clientId, snapshotId, target, contentMode = "empty") => {
          window.testCalls.installationPrepared = { clientId, snapshotId, target, contentMode };
          const root = target.basePath + "/fixture-client";
          return { version: 1, kind: "new_installation", id: "fixture-plan", createdAt: new Date().toISOString(), status: "blocked", contentMode,
            client: { id: clientId, slug: "fixture-client", name: "Тест <img src=x onerror=alert(1)>" }, target: { ...target, appPath: root },
            paths: { root, current: root + "/current", releases: root + "/releases", shared: root + "/shared" },
            database: { engine: "postgresql", host: "db.fixture.example", port: 5432, name: "fixture" },
            source: { snapshotId, repositoryUrl: document.querySelector("#repository-url").value, requestedBranch: document.querySelector("#repository-branch").value, branch: "main", revision: "a".repeat(40) },
            preflight: null, checks: [{ code: "POSTGRES_ADAPTER", label: "Адаптер PostgreSQL", status: "blocked", message: "Fixture: требуется адаптер PostgreSQL <img src=x>" }] };
        },
        checkInstallationServer: async (clientId, planId, snapshotId, target, credentials) => {
          window.testCalls.installationChecked = { clientId, planId, snapshotId, authenticated: credentials.password === "fixture-password" };
          const plan = await window.launcherApi.prepareInstallation(clientId, snapshotId, target, window.testCalls.installationPrepared?.contentMode || "empty");
          return { ...plan, ...(window.testNewPackage ? { status: "prepared", package: window.testNewPackage, checks: [] } : {}), preflight: { checkedAt: new Date().toISOString(), os: "Ubuntu fixture", postgresState: "ready" } };
        },
        getDeploymentState: async () => null,
        onDeploymentProgress: (callback) => { window.testDeploymentProgress = callback; return () => { window.testDeploymentProgress = null; }; },
        deployRemoteTarget: async (target, credentials, snapshotId, allowSwap) => {
          window.testCalls.deployment = { host: target.host, authenticated: credentials.password === "fixture-password", snapshotId, allowSwap };
          window.testDeploymentProgress?.({ id: "fixture-job", target, revision: "a".repeat(40), phase: "building", message: "Fixture build in progress", updatedAt: new Date().toISOString() });
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { id: "fixture-job", target, revision: "a".repeat(40), phase: "succeeded", message: "Fixture deploy completed", updatedAt: new Date().toISOString(), backupPath: "/var/backups/fixture.tar.gz", port: 3000 };
        },
        refreshDeployment: async (target) => ({ id: "fixture-job", target, revision: "a".repeat(40), phase: "succeeded", message: "Fixture result checked", updatedAt: new Date().toISOString() }),
        fetchSource: async (config) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { source: { phase: "ready", message: "Исходники получены, сайт не установлен.", snapshot: {
            id: "fixture-snapshot", repositoryUrl: config.url, requestedBranch: config.branch, branch: config.branch || "main", revision: "a".repeat(40),
            fileCount: 12, archiveBytes: 4096, archiveSha256: "b".repeat(64), sourcePath: "C:/fixture/source", project: { kind: "nextjs", packageManager: "npm" },
            warnings: ["Данные клиента требуют подготовки <img src=x>"]
          } }, repository: { ...blank, config, result: { status: "connected", message: "Чтение подтверждено.", checkedAt: "2026-10-28T10:00:00.000Z", defaultBranch: "main", selectedBranch: "main", revision: "a".repeat(40), branches: ["main"] } } };
        },
        checkRepository: async (config) => {
          window.testCalls.repositoryChecks++;
          window.testCalls.lastRepository = config;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { ...blank, config, result: { status: config.branch === "missing" ? "branch_missing" : "connected", canRead: true,
            checkedAt: "2026-10-28T10:00:00.000Z", message: config.branch === "missing" ? "Выбранная ветка не найдена." : "Чтение подтверждено.",
            defaultBranch: "main", selectedBranch: config.branch || "main", revision: config.branch === "missing" ? null : "a".repeat(40), branches: ["main", "fixture/<img>"] } };
        },
        chooseRepositoryKey: async () => "C:/fixture/key",
        createRepositoryKey: async () => ({ available: true, publicKey: "ssh-ed25519 fixture-public", fingerprint: "SHA256:fixture" }),
        copyRepositoryPublicKey: async () => true,
        openRepositoryGitHubSettings: async () => true,
        fetchJson: async (url) => {
          if (url.includes("client-detail?")) {
            if (window.testTargetMode === "error") throw new Error("Fixture API unavailable");
            return { client: { id: window.testTargetMode === "mismatch" ? "other-id" : "fixture-id", name: "Тест <img src=x onerror=alert(1)>", slug: "fixture-client" }, profile: {
              hostUrl: "https://fixture-lms.example", deployPath: "/srv/lms/fixture", databaseHost: "fixture-db.internal", databasePort: 5432, databaseName: "fixture"
            } };
          }
          return { clients: [{ id: "fixture-id", name: "Тест <img src=x onerror=alert(1)>", domain: "example.local", tariff: "base" }] };
        },
        startService: async () => { window.testCalls.startService = (window.testCalls.startService || 0) + 1; return { running: false, message: "Тест: порт не открылся" }; },
        stopService: async () => ({ running: false }),
        startAll: async () => {
          window.testCalls.startAll++;
          statuses.forEach((status) => Object.assign(status, { running: true, healthState: "healthy", ok: true }));
          return statuses;
        },
        stopAll: async () => statuses,
        openUrl: async (url) => { window.testCalls.openedUrl = url; return true; },
        openPgAdmin: async () => true,
        openFile: async () => true,
        openConfig: async () => true,
        readLog: async (filePath, options) => { window.testCalls.logReads = (window.testCalls.logReads || 0) + 1; (window.testCalls.logOptions ||= []).push({ fresh: options?.fresh === true }); if (window.testLogHandler) return window.testLogHandler(filePath, options); if (firstLog) { firstLog = false; await initialLog; } return "Fixture log"; },
        getPostgresSnapshot: async (table) => {
          window.testCalls.databaseReads = (window.testCalls.databaseReads || 0) + 1;
          if (window.testDatabaseHandler) return window.testDatabaseHandler(table);
          return { database: "fixture", selectedTable: "users", tables: [{ name: "users", rows: 1, totalBytes: 100 }], rows: [{ email: "<img src=x onerror=alert(2)>" }] };
        }
      };
      if (savedServers) {
        const records = {}, key = target => JSON.stringify([target.host, target.port, target.username, target.fingerprint]);
        const record = id => records[id] ||= { clientId: id, revision: 0, target: null, passwords: {} };
        const publicValue = (value, target = value.target) => ({ clientId: value.clientId, revision: value.revision, target: value.target && { ...value.target }, passwordSaved: !!target && !!value.passwords[key(target)] });
        window.launcherApi.getClientServer = async (id, target) => publicValue(record(id), target);
        window.launcherApi.saveClientServer = async (id, target, revision) => {
          const value = record(id); if (revision !== value.revision) throw Error("Fixture profile conflict");
          value.target = { ...target }; value.revision++; return publicValue(value);
        };
        window.launcherApi.toggleClientServerPassword = async (id, target, password, revision, forget) => {
          const value = record(id); if (revision !== value.revision) throw Error("Fixture profile conflict");
          if (!forget && !password) throw Error("Введите пароль сервера");
          value.target = { ...target }; value.revision++;
          if (forget) delete value.passwords[key(target)]; else value.passwords[key(target)] = password;
          return publicValue(value);
        };
        window.launcherApi.inspectRemoteTarget = async (target, credentials) => {
          const authenticated = credentials.savedForClient ? record(credentials.savedForClient).passwords[key(target)] === "fixture-password" : credentials.password === "fixture-password";
          if (!authenticated) throw Error("Fixture authentication failed");
          window.testCalls.savedSsh = { host: target.host, savedForClient: credentials.savedForClient || null, passwordInRenderer: Boolean(credentials.password) };
          return { os: "Ubuntu fixture", user: "root", node: "v22.fixture", npm: "fixture", postgres: "active", mysql: "inactive", mariadb: "inactive", projectPaths: [] };
        };
      }
      if (storageFault) Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Fixture storage unavailable", "SecurityError"); } });
    }, { storageFault: process.env.CORE_TEST_STORAGE_FAULT === "1", frameLifecycle: process.env.CORE_TEST_FRAME_LIFECYCLE === "1" || process.env.CORE_TEST_DRAFT_NAVIGATION === "1", performanceMode: process.env.CORE_TEST_PERFORMANCE === "1", savedServers: process.env.CORE_TEST_SAVED_SERVERS === "1" });
    await page.goto(pathToFileURL(path.join(__dirname, "../renderer/index.html")).href);
    if (process.env.CORE_TEST_CARD_ACCESS === "1") {
      const clientId = "48108c63-f9b1-4f97-8f62-b7e145be058e";
      await page.evaluate(async clientId => {
        window.releaseInitialLog(); testStatuses.forEach(status => Object.assign(status, { running: true, healthState: "healthy", ok: true }));
        window.testAccess = { clientId, revision: 1, values: { clientAdminName: "Isolated fixture", clientAdminLogin: "fixture_admin", systemAdminLogin: "fixture_system", host: "192.0.2.11", sshUsername: "root", sshPort: 22, databaseMode: "local_peer", databaseHost: "192.0.2.11", databasePort: 5432, databaseUser: "postgres" }, saved: { clientAdminPassword: true, systemAdminPassword: true, sshPassword: true, databasePassword: false } };
        launcherApi.installationAccessRequest = async (action, id, values, revision) => {
          if (id !== clientId) throw Error("Wrong fixture client");
          if (action !== "get") {
            if (revision !== testAccess.revision) throw Error("Fixture revision changed");
            testCalls.accessSaved = { id, passwordSupplied: values.clientAdminPassword === "fixture-new-admin-password" };
            const publicValues = { ...values }; for (const key of ["clientAdminPassword", "systemAdminPassword", "sshPassword", "databasePassword"]) delete publicValues[key];
            testAccess = { ...testAccess, revision: revision + 1, values: publicValues };
          }
          return structuredClone(testAccess);
        };
        launcherApi.fetchJson = async () => ({ client: { id: clientId, name: "Fixture", slug: "fixture-client" }, profile: { hostUrl: "http://192.0.2.11", databaseHost: "192.0.2.11", databasePort: 5432 } });
        setStoredPreviewClientId(clientId); setStoredPreviewClientName("Fixture");
        await setBrowserMode("deploy"); syncBrowserFrame(testStatuses);
      }, clientId);
      const frame = page.frameLocator("#embedded-panel-frame");
      await frame.locator('[data-panel-ready="true"]').waitFor({ timeout: 60000 });
      await frame.locator(`[data-client-id="${clientId}"]`).click({ timeout: 60000 });
      await frame.getByRole("heading", { name: "Пароли и доступы", exact: true }).waitFor({ timeout: 12000 }).catch(async error => {
        console.log(JSON.stringify({ fixtureDebug: await frame.locator("body").evaluate(() => ({ url: location.href, headings: Array.from(document.querySelectorAll("h1,h2,h3")).map(el => ({ text: el.textContent, visible: Boolean(el.getClientRects().length) })), errors: Array.from(document.querySelectorAll(".message-error")).map(el => el.textContent) })), pageErrors }));
        await page.screenshot({ path: path.join(os.tmpdir(), "core-card-access-error.png") }); throw error;
      });
      const password = frame.getByLabel("Пароль администратора · сохранён", { exact: true });
      await password.waitFor(); assert.equal(await password.inputValue(), "");
      await password.fill("fixture-new-admin-password");
      await frame.getByRole("button", { name: "Сохранить доступы клиента", exact: true }).click();
      await page.waitForFunction(() => window.testCalls.accessSaved?.passwordSupplied === true);
      await frame.getByText("Доступы сохранены. При установке вводить их повторно не нужно.", { exact: true }).waitFor();
      assert.equal(await password.inputValue(), "");
      assert.ok(!(await frame.locator("body").evaluate(() => JSON.stringify(localStorage))).includes("fixture-new-admin-password"));
      for (const theme of ["graphite", "porcelain"]) {
        await page.evaluate(theme => { currentPreferences = { ...currentPreferences, theme }; applyTheme(theme); syncDeployAppearance(); }, theme);
        await frame.locator(`html[data-core-theme="${theme}"]`).waitFor();
        await page.setViewportSize({ width: 1400, height: 1700 });
        await frame.locator(".credentials-card").filter({ has: frame.locator("#client-access-title") }).screenshot({ path: path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `client-access-${theme}.png`) });
      }
      await frame.getByRole("button", { name: "Новый клиент", exact: true }).click();
      const create = frame.locator("#client-editor");
      await create.getByLabel("Домен или IP клиента", { exact: true }).fill("192.0.2.80");
      await create.getByLabel("Название бренда", { exact: true }).focus();
      assert.equal(await create.getByLabel("Адрес LMS хоста", { exact: true }).inputValue(), "http://192.0.2.80");
      assert.equal(await create.getByLabel("Хост базы данных", { exact: true }).inputValue(), "192.0.2.80");
      await create.getByLabel("Пароль сервера", { exact: true }).fill("fixture-ssh-draft");
      page.once("dialog", dialog => dialog.accept());
      await create.getByRole("button", { name: "Очистить форму", exact: true }).click();
      assert.equal(await create.getByLabel("Пароль сервера", { exact: true }).inputValue(), "");
      await page.evaluate(async () => { setActiveView("repository"); await loadRepositoryTarget(); });
      assert.equal(await page.locator("#install-client-login").inputValue(), "fixture_admin");
      assert.equal(await page.locator("#install-system-login").inputValue(), "fixture_system");
      assert.equal(await page.locator("#install-client-password").inputValue(), "");
      assert.ok((await page.locator("#install-client-password").getAttribute("placeholder")).includes("Сохранён"));
      await page.evaluate(async clientId => {
        for (const [id, value] of Object.entries({ "remote-host": "192.0.2.11", "remote-port": "22", "remote-username": "root", "remote-base-path": "/srv/lms-core/clients", "remote-fingerprint": "SHA256:" + "A".repeat(43), "remote-password": "fixture-password" })) document.getElementById(id).value = value;
        sourceState = { phase: "ready", snapshot: { id: "fixture-snapshot", repositoryUrl: "", requestedBranch: "" } };
        document.getElementById("new-installation-content-mode").value = "empty";
        newInstallationPlan = { ...(await launcherApi.prepareInstallation(clientId, "fixture-snapshot", readRemoteTarget())), status: "prepared", checks: [], package: { id: "fixture-package", revision: "a".repeat(40), archiveBytes: 5000 }, preflight: { checkedAt: new Date().toISOString(), os: "Fixture", postgresState: "ready" } };
        executionMode = "remote";
        launcherApi.startInstallation = async (id, plan, source, target, auth, secrets) => {
          testCalls.accessInstall = { id, saved: secrets.useSavedAccess === true, emptySecretsInRenderer: !secrets.clientAdminPassword && !secrets.systemAdminPassword, clientLogin: secrets.clientAdminLogin, mode: secrets.databaseMode };
          return { id: "fixture-job", clientId: id, phase: "failed", updatedAt: new Date().toISOString(), target, message: "Mock only" };
        };
        renderNewInstallationPlan(); deploymentWorkflow.select("installation");
      }, clientId);
      await page.locator("#new-installation-start").click();
      await page.waitForFunction(() => window.testCalls.accessInstall);
      assert.deepEqual(await page.evaluate(() => testCalls.accessInstall), { id: clientId, saved: true, emptySecretsInRenderer: true, clientLogin: "fixture_admin", mode: "local_peer" });
      assert.equal(networkWrites, 0); assert.deepEqual(pageErrors, []);
      console.log("CARD_ACCESS UI accepted: actual panel/nonce-bound parent bridge, masked saved passwords, save acknowledgement, installer autofill. Only real GETs; all credential writes mocked."); return;
    }
    if (process.env.CORE_TEST_RECOVERY === "1") {
      await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
      await page.evaluate(async () => {
        const target = { host: "fixture.example", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/fixture", fingerprint: "SHA256:" + "A".repeat(43) };
        window.testSavedInstallation = { id: "fixture-new-job", clientId: "fixture-id", releaseId: "fixture-release", phase: "needs_attention", failedStep: "initialize", retryAvailable: true, message: "Доступно восстановление запуска", revision: "a".repeat(40), target, webPort: 3000, updatedAt: new Date().toISOString() };
        setStoredPreviewClientId("fixture-id"); setStoredPreviewClientName("Fixture client"); await loadNewInstallationPlan();
      });
      await deploymentStep("connection"); await page.locator("#remote-fingerprint").fill("SHA256:" + "A".repeat(43)); await page.locator("#remote-password").fill("fixture-password");
      await deploymentStep("installation");
      assert.equal(await page.locator("#install-db-mode").inputValue(), "local_peer");
      await page.locator("#recover-new-installation").click();
      await page.waitForFunction(() => window.testCalls.recovery);
      assert.equal(await page.evaluate(() => window.testCalls.recovery.authenticated), true);
      assert.equal(await page.locator("#recover-new-installation").isVisible(), false);
      assert.ok((await page.locator("#new-installation-result").innerText()).includes("можно повторить"));
      assert.deepEqual(pageErrors, []); console.log("RECOVERY UI: automatic peer default, guarded recovery action and cleared blocked state accepted; mock SSH only"); return;
    }
    if (process.env.CORE_TEST_CLIENT_DELETE === "1") {
      await page.evaluate(() => { setStoredPreviewClientId("fixture-id"); setStoredPreviewClientName("Fixture client"); updatePreviewClientCaption(); setActiveView("browser"); });
      // No iframe is loaded in this mode; the existing dirty-form guard has its own regression mode.
      await page.evaluate(() => { activeBrowserMode = "preview"; window.testClientDeleteMode = "cancel"; });
      const button = page.locator("#delete-client-button");
      assert.equal(await button.isEnabled(), true);
      await button.click(); await page.waitForFunction(() => document.querySelector("#browser-navigation-warning").textContent.includes("Удаление отменено"));
      assert.equal(await page.evaluate(() => getStoredPreviewClientId()), "fixture-id");
      await page.evaluate(() => { window.testClientDeleteMode = "fail"; });
      await button.click(); await page.waitForFunction(() => document.querySelector("#browser-navigation-warning").textContent.includes("карточка сохранена"));
      assert.equal(await page.evaluate(() => getStoredPreviewClientId()), "fixture-id");
      await page.evaluate(() => { window.testClientDeleteMode = "wait"; });
      await button.click(); await page.waitForFunction(() => typeof window.resolveClientDelete === "function");
      assert.equal(await button.isDisabled(), true);
      await page.getByRole("button", { name: "Сервисы", exact: true }).click();
      assert.equal(await page.evaluate(() => activeView), "browser");
      await page.evaluate(() => { window.testClientDeleteProgress({ clientId: "fixture-id", message: "Fixture database deletion" }); });
      assert.ok((await page.locator("#browser-navigation-warning").innerText()).includes("Fixture database deletion"));
      await page.evaluate(() => window.resolveClientDelete());
      await page.waitForFunction(() => document.body.dataset.clientDeleting === "false");
      assert.equal(await page.evaluate(() => getStoredPreviewClientId()), "");
      assert.equal(await button.isDisabled(), true); assert.deepEqual(pageErrors, []);
      console.log("CLIENT_DELETE UI: cancel, failure, progress, busy navigation guard and successful list refresh accepted"); return;
    }
    if (process.env.CORE_TEST_REMOVAL === "1") {
      await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
      await page.evaluate(async () => {
        const target = { host: "fixture.example", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/fixture", fingerprint: "SHA256:" + "A".repeat(43) };
        window.testSavedInstallation = { id: "fixture-new-job", clientId: "fixture-id", releaseId: "fixture-release", phase: "succeeded", message: "Fixture installed", revision: "a".repeat(40), target, webPort: 3000, updatedAt: new Date().toISOString() };
        setStoredPreviewClientId("fixture-id"); setStoredPreviewClientName("Fixture client"); await loadNewInstallationPlan();
      });
      await deploymentStep("connection");
      await page.locator("#remote-fingerprint").fill("SHA256:" + "A".repeat(43)); await page.locator("#remote-password").fill("fixture-password");
      await deploymentStep("access"); await page.locator("#lms-removal-panel").evaluate(el => { el.open = true; });
      assert.equal(await page.locator("#lms-removal-execute").isDisabled(), true);
      await page.locator("#lms-removal-prepare").click();
      await page.waitForFunction(() => window.testCalls.removalChecked);
      await page.waitForFunction(() => !document.querySelector("#lms-removal-execute").disabled);
      assert.ok((await page.locator("#lms-removal-result").innerText()).includes("Сайт пока работает"));
      await page.evaluate(() => { window.testRemovalCancel = true; });
      await page.locator("#lms-removal-execute").click();
      await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("Удаление отменено"));
      assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
      await page.evaluate(() => { window.testRemovalCancel = false; window.testRemovalFailure = true; });
      await page.locator("#lms-removal-execute").click();
      await page.waitForFunction(() => document.querySelector("#lms-removal-result").textContent.includes("Прежние файлы и службы восстановлены"));
      assert.equal(await page.locator("#lms-removal-execute").isDisabled(), true);
      await page.evaluate(() => { window.testRemovalFailure = false; });
      await page.locator("#lms-removal-prepare").click(); await page.waitForFunction(() => !document.querySelector("#lms-removal-execute").disabled);
      await page.locator("#lms-removal-execute").click();
      await page.waitForFunction(() => document.querySelector("#lms-removal-result").textContent.includes("LMS и ее база данных удалены"));
      assert.equal(await page.locator("#lms-removal-execute").isDisabled(), true);
      assert.equal(await page.locator("#new-installation-open-lms").isDisabled(), true);
      await page.locator("#lms-removal-refresh").click();
      await page.waitForFunction(() => !remoteBusy);
      assert.ok((await page.locator("#lms-removal-result").innerText()).includes("/srv/lms-core/backups/fixture/fixture-removal"));
      assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
      assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes("fixture-password"));
      for (const theme of ["graphite", "porcelain"]) {
        await page.evaluate(theme => applyTheme(theme), theme);
        await page.setViewportSize({ width: 1100, height: 860 }); await page.locator("#lms-removal-panel").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `lms-removal-${theme}.png`) });
      }
      console.log("Full removal UI passed: read-only preparation, cancellation, failure/retry, LMS+DB success with retained client/accesses, disabled old viewer, read-only result refresh. Mock bridge only."); return;
    }
    if (process.env.CORE_TEST_SAVED_SERVERS === "1") {
      await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
      await page.evaluate(async () => { setStoredPreviewClientId("fixture-id"); setStoredPreviewClientName("Fixture client"); await loadRemoteTarget(); });
      await deploymentStep("connection");
      assert.equal(await page.locator("#remote-host").inputValue(), "");
      await page.locator("#remote-host").fill("fixture.example");
      await page.locator("#remote-fingerprint").fill("SHA256:" + "A".repeat(43));
      await page.locator("#remote-password").fill("fixture-password");
      await page.locator("#remote-password-lock").click();
      await page.waitForFunction(() => document.querySelector("#remote-password-lock").getAttribute("aria-pressed") === "true");
      assert.equal(await page.locator("#remote-password").inputValue(), "");
      assert.equal(await page.locator("#remote-password").getAttribute("readonly"), "");
      await page.locator("#remote-operation-mode").selectOption("update");
      await deploymentStep("preparation");
      await page.locator("#remote-inspect-button").click();
      await page.waitForFunction(() => window.testCalls.savedSsh);
      assert.deepEqual(await page.evaluate(() => window.testCalls.savedSsh), { host: "fixture.example", savedForClient: "fixture-id", passwordInRenderer: false });
      await deploymentStep("connection");
      await page.evaluate(async () => { setStoredPreviewClientId("other-client"); await loadRemoteTarget(); });
      assert.equal(await page.locator("#remote-host").inputValue(), "");
      assert.equal(await page.locator("#remote-password-lock").getAttribute("aria-pressed"), "false");
      await page.evaluate(async () => { setStoredPreviewClientId("fixture-id"); await loadRemoteTarget(); });
      assert.equal(await page.locator("#remote-host").inputValue(), "fixture.example");
      assert.equal(await page.locator("#remote-password-lock").getAttribute("aria-pressed"), "true");
      await page.locator("#remote-password-lock").click();
      await page.waitForFunction(() => document.querySelector("#remote-password-lock").getAttribute("aria-pressed") === "false");
      assert.equal(await page.locator("#remote-password").inputValue(), "");
      await page.evaluate(async () => { await loadRemoteTarget(); });
      assert.equal(await page.locator("#remote-password-lock").getAttribute("aria-pressed"), "false");
      await page.locator("#remote-password").fill("fixture-password");
      await page.locator("#remote-password-lock").click();
      await page.waitForFunction(() => document.querySelector("#remote-password-lock").getAttribute("aria-pressed") === "true");
      for (const theme of ["graphite", "porcelain"]) {
        await page.evaluate(theme => { applyTheme(theme); }, theme);
        for (const width of [1366, 900]) {
          await page.setViewportSize({ width, height: 860 });
          await page.locator("#remote-password-row").scrollIntoViewIfNeeded();
          assert.ok(await page.locator(".main-stage").evaluate(el => el.scrollWidth <= el.clientWidth + 1));
          await page.screenshot({ path: path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `server-password-${theme}-${width}.png`) });
        }
      }
      assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
      assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes("fixture-password"));
      console.log("Saved-server UI passed: lock, main-process credential marker, client switch/restore, unlock/reload, no secret in field or storage, two themes/two widths. Mock SSH only.");
      return;
    }
    if (process.env.CORE_TEST_PERFORMANCE === "1") {
      await page.waitForFunction(() => window.testStartupCalls?.length === 3);
      assert.deepEqual((await page.evaluate(() => window.testStartupCalls)).sort(), ["config", "preferences", "visibility"]);
      assert.notEqual(await page.locator("body").getAttribute("data-launcher-ready"), "true");
      await page.evaluate(() => { window.testStartupRelease.preferences(); window.testStartupRelease.config(); window.testStartupRelease.visibility(); window.releaseInitialLog(); });
      await page.waitForFunction(() => document.body.dataset.launcherReady === "true");
      await page.evaluate(() => {
        window.testLogText = Array.from({ length: 4000 }, (_, index) => `Fixture line ${index}`).join("\n") + "\n";
        window.testLogHandler = async () => window.testLogText;
      });
      await page.getByRole("button", { name: "Журнал", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#log-panel-content").textContent.endsWith("Fixture line 3999\n"));
      const unchanged = await page.evaluate(async () => {
        const original = window.coreWorkspaceTools;
        window.testLogScans = 0;
        window.coreWorkspaceTools = { ...original, logTail(...args) { window.testLogScans++; return original.logTail(...args); } };
        const log = document.querySelector("#log-panel-content"), textNode = log.firstChild;
        log.scrollTop = 120; const scroll = log.scrollTop;
        let mutations = 0; const observer = new MutationObserver(records => { mutations += records.length; });
        observer.observe(log, { childList: true, characterData: true, subtree: true });
        for (let poll = 0; poll < 20; poll++) await refreshActiveLog();
        await Promise.resolve(); observer.disconnect();
        return { scans: window.testLogScans, mutations, retainedNode: textNode === log.firstChild, retainedScroll: scroll === log.scrollTop };
      });
      assert.deepEqual(unchanged, { scans: 0, mutations: 0, retainedNode: true, retainedScroll: true });
      const changed = await page.evaluate(async () => {
        window.testLogText += "Changed line\n"; await refreshActiveLog();
        const afterAppend = window.testLogScans;
        persistSettingsPatch({ logLineLimit: 300 }); await refreshActiveLog();
        return { afterAppend, afterLimit: window.testLogScans, lines: document.querySelector("#log-panel-content").textContent.trimEnd().split("\n").length };
      });
      assert.deepEqual(changed, { afterAppend: 1, afterLimit: 2, lines: 300 });
      const manual = await page.evaluate(async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const options = [];
        window.testLogHandler = async (_path, input) => { options.push(input.fresh); if (options.length === 1) await gate; return window.testLogText; };
        const ordinary = refreshActiveLog(); await Promise.resolve(); await Promise.resolve();
        const forced = refreshActiveLog({ force: true }); release();
        await Promise.all([ordinary, forced]);
        return options;
      });
      assert.deepEqual(manual, [false, true]);
      const beforeDispatch = await page.evaluate(async () => {
        const options = [];
        window.testLogHandler = async (_path, input) => { options.push(input.fresh); return window.testLogText; };
        const ordinary = refreshActiveLog(), forced = refreshActiveLog({ force: true });
        await Promise.all([ordinary, forced]);
        return options;
      });
      assert.deepEqual(beforeDispatch, [true]);
      const stale = await page.evaluate(async () => {
        const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
        const jobs = new Map(), calls = [];
        for (const name of ["getInstallationPlan", "getInstallationState", "getIpPublication"]) {
          launcherBridge[name] = id => { calls.push([id, name]); return new Promise(resolve => jobs.set(id + name, resolve)); };
        }
        const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
        const state = (id, message) => ({ id, clientId: id, releaseId: id, revision: "a".repeat(40), phase: "succeeded", updatedAt: new Date().toISOString(), message,
          target: { host: "fixture.example", appPath: "/srv/lms-core/clients/fixture" }, webPort: 3000 });
        setStoredPreviewClientId(ids[0]); const first = loadNewInstallationPlan(); await flush();
        const parallel = calls.length === 3;
        jobs.get(ids[0] + "getInstallationState")(state(ids[0], "Older client result"));
        jobs.get(ids[0] + "getIpPublication")(null); await flush();
        const heldTogether = newInstallationState === null;
        setStoredPreviewClientId(ids[1]); const second = loadNewInstallationPlan(); await flush();
        jobs.get(ids[0] + "getInstallationPlan")(null); await first;
        const staleIgnored = newInstallationState === null;
        jobs.get(ids[1] + "getInstallationPlan")(null); jobs.get(ids[1] + "getInstallationState")(state(ids[1], "Current client result")); jobs.get(ids[1] + "getIpPublication")(null);
        await second;
        return { parallel, heldTogether, staleIgnored, current: newInstallationState.clientId === ids[1], installBlocked: document.querySelector("#new-installation-start").disabled };
      });
      assert.deepEqual(stale, { parallel: true, heldTogether: true, staleIgnored: true, current: true, installBlocked: true });
      assert.deepEqual(pageErrors, []);
      console.log("Performance UI accepted: parallel startup reads, atomic installation snapshot, stale-client guard, unchanged log scans/mutations=0, append/line-limit update, forced refresh after active poll. Mock bridge only.");
      return;
    }
    if (process.env.CORE_TEST_VISUAL === "1") {
      await page.evaluate(() => window.releaseInitialLog());
      await page.waitForFunction(() => document.body.dataset.launcherReady === "true");
      await page.evaluate(() => window.testStatuses.forEach(status => Object.assign(status, { running: true, healthState: "healthy", ok: true })));
      await page.locator("#refresh-button").click();
      await page.getByRole("button", { name: "Настройки", exact: true }).click();
      await page.locator("#ui-font-select").selectOption("technical");
      await page.locator("#content-width-select").selectOption("focused");
      await page.locator("#border-contrast-select").selectOption("strong");
      assert.equal(await page.locator("body").getAttribute("data-ui-font"), "technical");
      assert.equal(await page.locator("html").getAttribute("data-core-border-contrast"), "strong");
      assert.ok((await page.locator("body").evaluate(el => getComputedStyle(el).fontFamily)).includes("Bahnschrift"));
      await page.locator('[data-settings-tab="behavior"]').click();
      await page.locator("#show-service-summary-checkbox").uncheck();
      assert.equal(await page.locator(".rail-status").isVisible(), false);
      await page.locator("#show-service-summary-checkbox").check();
      await page.locator("#keyboard-shortcuts-checkbox").uncheck();
      await page.keyboard.press("Control+1");
      assert.equal(await page.locator("body").getAttribute("data-workspace-view"), "settings");
      await page.locator("#keyboard-shortcuts-checkbox").check();
      await page.locator('[data-settings-tab="logs"]').click();
      await page.locator("#log-line-limit-select").selectOption("300");
      await page.locator("#log-interval-select").selectOption("10000");
      await page.locator("#log-wrap-checkbox").check();
      assert.equal(await page.evaluate(() => window.testIntervals.some(item => item.delay === 10000)), true);
      assert.equal(await page.evaluate(() => window.testCalls.savedPreferences.logLineLimit), 300);
      await page.evaluate(() => { window.testLogHandler = async () => Array.from({ length: 500 }, (_, i) => `Log line ${i + 1}`).join("\n"); });
      await page.getByRole("button", { name: "Журнал", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#log-panel-content").textContent.startsWith("Log line 201\n"));
      assert.equal(await page.locator("#log-panel-content").evaluate(el => getComputedStyle(el).whiteSpace), "pre-wrap");
      await page.keyboard.press("Control+1");
      assert.equal(await page.locator("body").getAttribute("data-workspace-view"), "overview");
      await page.keyboard.press("Control+Comma");
      assert.equal(await page.locator("body").getAttribute("data-workspace-view"), "settings");
      await page.locator('[data-settings-tab="appearance"]').click();
      const views = ["overview", "services", "browser", "lms", "database", "repository", "logs", "settings"];
      for (const theme of ["graphite", "porcelain"]) {
        await page.getByRole("button", { name: "Настройки", exact: true }).click();
        await page.locator('[data-settings-tab="appearance"]').click();
        await page.locator(`[data-theme-choice="${theme}"]`).click();
        for (const view of views) {
          await page.locator(`.nav-button[data-view-target="${view}"]`).click();
          await page.waitForFunction(view => document.body.dataset.workspaceView === view, view);
          for (const width of [1366, 900]) {
            await page.setViewportSize({ width, height: 820 });
            assert.ok(await page.locator(".main-stage").evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${theme}/${view}/${width} overflows`);
          }
          await page.setViewportSize({ width: 1366, height: 820 });
          await page.screenshot({ path: path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `core-ui-${theme}-${view}.png`) });
        }
      }
      await page.locator('[data-settings-tab="behavior"]').click();
      await page.locator("#default-view-select").focus();
      await page.keyboard.press("Control+1");
      assert.equal(await page.locator("body").getAttribute("data-workspace-view"), "settings");
      assert.deepEqual(pageErrors, []);
      console.log("Core visual/preferences acceptance passed: 8 sections, 2 themes, 2 widths, new controls, shortcuts and logs.");
      return;
    }
    if (process.env.CORE_TEST_SOURCE_LIBRARY === "1") {
      await page.evaluate(() => window.releaseInitialLog());
      await page.waitForFunction(() => document.body.dataset.launcherReady === "true");
      await page.getByRole("button", { name: "Источники кода", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "Обзор", exact: true }).count(), 0);
      assert.equal(await page.locator("#view-overview .service-pill, #overview-next-step").count(), 0);
      await page.locator("#source-library-add").click();
      await page.locator("#source-library-name").fill("Кофейни");
      await page.locator("#source-library-url").fill("git@github.com:fixture/coffee.git");
      await page.locator("#source-library-note").fill("Рабочая LMS для кофеен.\nМатериалы заполняются отдельно.");
      await page.locator("#source-library-save").click();
      await page.waitForFunction(() => document.querySelectorAll(".source-card").length === 1);
      await page.locator("#source-library-add").click();
      await page.locator("#source-library-name").fill("Учебный стенд");
      await page.locator("#source-library-url").fill("git@github.com:fixture/sandbox.git");
      await page.locator("#source-library-branch").fill("develop");
      await page.locator("#source-library-note").fill("Для проверки новых настроек. Не использовать для клиентов.");
      await page.locator("#source-library-save").click();
      await page.waitForFunction(() => document.querySelectorAll(".source-card").length === 2);
      await page.getByRole("button", { name: "Редактировать источник Кофейни", exact: true }).click();
      await page.locator("#source-library-note").fill('Заметка <img src=x onerror=alert(1)>');
      await page.evaluate(() => { window.testFailSourceSave = true; });
      await page.locator("#source-library-save").click();
      await page.waitForFunction(() => document.querySelector("#source-library-form-error").textContent.includes("write failure"));
      assert.equal(await page.locator("#source-library-note").inputValue(), 'Заметка <img src=x onerror=alert(1)>');
      await page.evaluate(() => { window.testFailSourceSave = false; });
      await page.locator("#source-library-note").fill("Рабочая LMS для кофеен. Материалы заполняются отдельно.");
      await page.locator("#source-library-save").click();
      await page.waitForFunction(() => document.querySelector("#source-library-form").classList.contains("hidden"));
      assert.equal(await page.locator(".source-card img").count(), 0);
      assert.equal(await page.evaluate(() => window.testCalls.repositoryChecks), 0);
      assert.equal(await page.evaluate(() => window.testCalls.startAll), 0);
      for (const theme of ["ember", "porcelain"]) {
        await page.evaluate((theme) => applyTheme(theme), theme);
        for (const width of [1366, 1180, 920]) {
          await page.setViewportSize({ width, height: 800 });
          assert.equal(await page.locator("#view-overview").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
        }
        await page.setViewportSize({ width: 1366, height: 800 });
        const screenshot = path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `lms-core-sources-${theme}.png`);
        await page.screenshot({ path: screenshot }); console.log(screenshot);
      }
      await page.getByRole("button", { name: "Открыть источник Кофейни", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#view-repository").classList.contains("is-current"));
      assert.equal(await page.locator("#repository-url").inputValue(), "git@github.com:fixture/coffee.git");
      assert.equal(await page.evaluate(() => window.testCalls.repositoryChecks), 0);
      await page.getByRole("button", { name: "Источники кода", exact: true }).click();
      assert.ok((await page.locator(".source-card-note").first().innerText()).includes("Материалы"));
      assert.deepEqual(pageErrors, []);
      console.log("Source library UI passed: add/edit/notes, write-error retention, inert opening, light/dark/narrow layouts. Mock bridge only.");
      return;
    }
    if (process.env.CORE_TEST_FRAME_LIFECYCLE === "1" || process.env.CORE_TEST_DRAFT_NAVIGATION === "1") {
      await page.waitForFunction(() => document.body.dataset.launcherReady === "true");
      await page.evaluate(() => { clearInterval(statusPollTimer); clearInterval(logPollTimer); });
      assert.equal(await page.locator("#embedded-panel-frame").getAttribute("src"), "about:blank", "Overview startup must not eagerly create a hidden Next iframe");
      await page.getByRole("button", { name: "Клиенты", exact: true }).click();
      const frameLocator = page.frameLocator("#embedded-panel-frame");
      await frameLocator.getByLabel("Fixture draft", { exact: true }).fill("Retained unsaved draft");
      const frame = page.frames().find((item) => item.parentFrame() === page.mainFrame() && item.url().startsWith("http://127.0.0.1:3002/"));
      const originalDocument = await frame.evaluate(() => window.fixtureDocumentId);
      const originalUrl = await page.locator("#embedded-panel-frame").getAttribute("src");
      if (process.env.CORE_TEST_DRAFT_NAVIGATION === "1") {
        await frameLocator.getByLabel("Fixture draft", { exact: true }).click();
        await frame.evaluate(() => { window.fixtureDirty = true; window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = ""; }; });
        let dialogs = 0; page.on("dialog", async (dialog) => { dialogs++; await dialog.dismiss(); });
        await page.evaluate(() => applyPreviewClient("different-client", "Different client"));
        const state = await page.evaluate(() => ({ clientId: getStoredPreviewClientId(), mode: activeBrowserMode }));
        assert.equal(frame.url(), originalUrl);
        assert.deepEqual(state, { clientId: "", mode: "deploy" });
        const layouts = [];
        for (const viewport of [{ width: 1366, height: 768 }, { width: 1180, height: 760 }]) {
          await page.setViewportSize(viewport);
          for (const focus of [false, true]) {
            await page.evaluate((focus) => setBrowserFocusMode(focus), focus);
            const bounds = await page.evaluate(() => ({ viewport: innerHeight, frameBottom: document.querySelector("#embedded-panel-frame").getBoundingClientRect().bottom, frameHeight: document.querySelector("#embedded-panel-frame").clientHeight, outerScroll: document.querySelector("#view-browser").scrollHeight, outerHeight: document.querySelector("#view-browser").clientHeight, horizontal: document.querySelector("#view-browser").scrollWidth, width: document.querySelector("#view-browser").clientWidth }));
            assert.ok(bounds.frameBottom <= bounds.viewport && bounds.frameHeight >= 350, JSON.stringify(bounds));
            assert.ok(bounds.outerScroll <= bounds.outerHeight + 1 && bounds.horizontal <= bounds.width + 1, JSON.stringify(bounds));
            layouts.push({ viewportWidth: viewport.width, viewportHeight: viewport.height, focus, ...bounds });
          }
        }
        await page.evaluate(() => setBrowserFocusMode(false));
        console.log(JSON.stringify({ navigationWarningLayouts: layouts }));
        assert.equal(dialogs, 0, "Preflight prevents navigation before browser beforeunload is needed");
        assert.equal(await frameLocator.getByLabel("Fixture draft", { exact: true }).inputValue(), "Retained unsaved draft");
        await page.locator("#reload-embedded-panel-button").click();
        assert.equal(await frame.evaluate(() => window.fixtureDocumentId), originalDocument);
        await frame.evaluate(() => { window.fixtureDirty = false; window.fixtureBusy = true; });
        assert.equal(await page.evaluate(() => setBrowserMode("preview")), false);
        assert.ok((await page.locator("#browser-navigation-warning").innerText()).includes("выполняется операция"));
        await frame.evaluate(() => { window.fixtureBusy = false; window.fixtureIgnoreState = true; });
        const timeoutStarted = Date.now();
        assert.equal(await page.evaluate(() => setBrowserMode("preview")), false);
        const timeoutMs = Date.now() - timeoutStarted;
        assert.ok(timeoutMs >= 2400 && timeoutMs < 4500);
        await frame.evaluate(() => { window.fixtureIgnoreState = false; window.fixtureStateDelay = 150; });
        await page.evaluate(() => Promise.all([setBrowserMode("preview"), setBrowserMode("deploy")]));
        assert.equal(await page.evaluate(() => activeBrowserMode), "deploy", "A later click wins while an older preflight waits");
        await frame.evaluate(() => { window.onbeforeunload = null; window.fixtureStateDelay = 0; });
        await page.evaluate(() => applyPreviewClient("different-client", "Different client"));
        await page.waitForFunction(() => activeBrowserMode === "preview" && getStoredPreviewClientId() === "different-client");
        assert.equal(await page.locator("#browser-navigation-warning").isVisible(), false);
        assert.deepEqual(pageErrors, []);
        console.log(JSON.stringify({ draftNavigationAccepted: true, dirtyAndReloadBlocked: true, busyBlocked: true, timeoutMs, latestNavigationWins: true, cleanSwitchRecovers: true, noBeforeUnloadBypass: true }));
        return;
      }
      await page.evaluate(async () => {
        Object.assign(window.testStatuses.find((item) => item.id === "deploy-panel"), { healthState: "unhealthy", message: "Fixture transient timeout" });
        await refreshStatuses();
      });
      assert.equal(await page.locator("#embedded-panel-frame").isVisible(), false);
      assert.equal(await page.locator("#embedded-panel-frame").getAttribute("src"), originalUrl);
      assert.equal(await frame.evaluate(() => window.fixtureDocumentId), originalDocument);
      assert.ok((await page.locator("#embedded-panel-offline-text").innerText()).includes("несохраненные"));
      await page.getByRole("button", { name: "Повторить проверку", exact: true }).click();
      assert.equal(await page.evaluate(() => window.testCalls.startService || 0), 0, "Retry an alive but unready process, do not start another one");
      await page.evaluate(async () => { window.testStatuses.find((item) => item.id === "deploy-panel").healthState = "healthy"; await refreshStatuses(); });
      assert.equal(await page.locator("#embedded-panel-frame").isVisible(), true);
      assert.equal(await frameLocator.getByLabel("Fixture draft", { exact: true }).inputValue(), "Retained unsaved draft");
      assert.equal(await frame.evaluate(() => window.fixtureDocumentId), originalDocument);
      await page.getByRole("button", { name: "Источники кода", exact: true }).click();
      await page.evaluate(() => refreshStatuses());
      await page.getByRole("button", { name: "Клиенты", exact: true }).click();
      assert.equal(await frame.evaluate(() => window.fixtureDocumentId), originalDocument);
      await page.evaluate(async () => { if (!await canLeaveDeployPanel()) throw new Error("Clean fixture preflight failed"); setStoredPreviewClientId("different-client"); browserClientIdInput.value = "different-client"; await setBrowserMode("deploy", undefined, true); });
      await frameLocator.getByLabel("Fixture draft", { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector("#embedded-panel-frame").src.includes("different-client"));
      const changedFrame = page.frames().find((item) => item.parentFrame() === page.mainFrame() && item.url().includes("different-client"));
      assert.notEqual(await changedFrame.evaluate(() => window.fixtureDocumentId), originalDocument);
      assert.equal(await frameLocator.getByLabel("Fixture draft", { exact: true }).inputValue(), "");
      await page.evaluate(async () => { window.testStatuses.find((item) => item.id === "lms-web").healthState = "unhealthy"; await setBrowserMode("preview"); });
      assert.equal(await page.locator("#embedded-panel-frame").isVisible(), false, "Git preview must not reuse the old iframe");
      assert.equal(await page.locator("#git-preview-controls").isVisible(), true);
      assert.deepEqual(pageErrors, []);
      console.log("Frame lifecycle smoke passed: lazy first open, retained same-target document/draft during transient failure, one explicit health retry without start, cross-client isolation.");
      return;
    }
    await page.waitForFunction(() => document.querySelector("#summary-text").textContent.includes("0 из 4"));
    assert.equal(await page.locator(".service-pill").count(), 0);
    assert.equal(await page.locator("#start-all-button").innerText(), "Запустить ядро");
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.evaluate(() => window.releaseInitialLog());
    await page.waitForFunction(() => document.body.dataset.launcherReady === "true");
    assert.equal(await page.locator("#view-settings").evaluate((element) => element.classList.contains("is-current")), true);
    const retained = await page.evaluate(async () => {
      const card = document.querySelector(".service-card");
      window.testStatuses[0].checkedAt = "2026-10-28T20:01:00Z";
      await refreshStatuses();
      return document.querySelector(".service-card") === card;
    });
    assert.equal(retained, true);
    await page.locator("#refresh-button").click();
    assert.equal(await page.evaluate(() => window.testCalls.lastStatusFresh), true);
    const visibility = await page.evaluate(async () => {
      const before = window.testCalls.statusReads;
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      for (const timer of window.testIntervals.filter((item) => [5000, 2500].includes(item.delay))) timer.callback();
      await Promise.resolve();
      const skipped = window.testCalls.statusReads === before;
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
      await statusRefreshPromise;
      return { skipped, fresh: window.testCalls.lastStatusFresh };
    });
    assert.deepEqual(visibility, { skipped: true, fresh: true });
    const nativeVisibility = await page.evaluate(async () => {
      await statusRefreshPromise;
      const before = window.testCalls.statusReads;
      window.testNativeVisibility(false);
      // Native hide wins even if Chromium's document.hidden still says false.
      for (const timer of window.testIntervals.filter((item) => [5000, 2500].includes(item.delay))) timer.callback();
      await Promise.resolve();
      const skipped = window.testCalls.statusReads === before;
      window.testNativeVisibility(true);
      document.dispatchEvent(new Event("visibilitychange"));
      window.testNativeVisibility(true);
      await statusRefreshPromise;
      return { skipped, refreshes: window.testCalls.statusReads - before, fresh: window.testCalls.lastStatusFresh };
    });
    assert.deepEqual(nativeVisibility, { skipped: true, refreshes: 1, fresh: true });
    await page.getByRole("button", { name: "Сервисы", exact: true }).click();
    await page.locator(".service-card").nth(1).getByRole("button", { name: "Запустить", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#diagnostics-text").textContent.includes("Тест: порт не открылся"));
    assert.equal(await page.locator(".service-card").nth(1).locator(".open-url-button").isDisabled(), true);
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    assert.equal(await page.locator("#remote-operation-mode").inputValue(), "new");
    assert.equal(await page.locator("#remote-app-path-row").isVisible(), false);
    assert.equal(await page.locator("#remote-update-actions").isVisible(), false);
    await deploymentStep("preparation");
    assert.equal(await page.locator("#new-installation-panel").isVisible(), true);
    assert.equal(await page.locator("#new-installation-server-check").isDisabled(), true);
    await page.locator("#new-installation-prepare").click();
    assert.ok((await page.locator("#remote-feedback").innerText()).includes("Сначала выберите клиента"));
    await deploymentStep("connection");
    await page.locator("#remote-operation-mode").selectOption("update");
    await deploymentStep("installation");
    assert.equal(await page.locator("#remote-update-actions").isVisible(), true);
    await deploymentStep("connection");
    await page.locator("#remote-probe-button").click();
    await page.waitForFunction(() => document.querySelector("#remote-candidate").textContent.includes("Получен из сети"));
    assert.equal(await page.locator("#remote-fingerprint").inputValue(), "");
    await deploymentStep("preparation");
    await page.locator("#remote-inspect-button").click();
    await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("Пароль пока не отправлялся"));
    assert.equal(await page.evaluate(() => Boolean(window.testCalls.remoteInspected)), false);
    await deploymentStep("connection");
    await page.locator("#remote-fingerprint").fill("SHA256:" + "A".repeat(43));
    await remotePassword("fixture-password");
    await deploymentStep("preparation");
    await page.locator("#remote-inspect-button").click();
    await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("SSH-вход подтверждён"));
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    assert.equal(await page.evaluate(() => window.testCalls.remoteInspected), true);
    assert.ok((await page.locator("#remote-inventory").innerText()).includes("Ubuntu fixture"));
    await page.evaluate(() => { window.testFailRemotePreflight = true; });
    await page.locator("#remote-preflight-button").click();
    await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("Fixture SSH unavailable"));
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    await page.evaluate(() => { window.testFailRemotePreflight = false; });
    await page.locator("#remote-preflight-button").click();
    await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("Предварительная проверка завершена"));
    assert.equal(await page.evaluate(() => window.testCalls.preflightChecked), true);
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    assert.ok((await page.locator("#remote-preflight-result").innerText()).includes("Режим данных: json"));
    await page.locator("#repository-choose-client").click();
    await page.waitForSelector(".modal-client-button");
    assert.equal(await page.locator("#preview-client-modal-title").innerText(), "Получатель: выберите клиента");
    assert.equal(await page.locator(".modal-client-button").evaluate((element) => getComputedStyle(element).flexDirection), "column");
    await page.locator(".modal-client-button").click();
    assert.equal(await page.locator("#remote-password").inputValue(), "");
    await page.waitForFunction(() => document.querySelector("#repository-target-host").textContent === "https://fixture-lms.example");
    assert.equal(await page.locator("#view-repository").isVisible(), true);
    assert.equal(await page.locator(".side-rail").isVisible(), true);
    assert.equal(await page.locator("#repository-target-client img").count(), 0);
    assert.equal(await page.locator("#repository-target-path").innerText(), "/srv/lms/fixture");
    assert.equal(await page.locator("#repository-target-database").innerText(), "fixture-db.internal:5432 / fixture");
    await page.evaluate(() => { window.testTargetMode = "error"; });
    await page.locator("#repository-refresh-target").click();
    await page.waitForFunction(() => document.querySelector("#repository-target-feedback").textContent.includes("Fixture API unavailable"));
    assert.equal(await page.locator("#repository-target-host").innerText(), "Не задан");
    assert.equal(await page.locator("#repository-configure-target").isDisabled(), true);
    await page.evaluate(() => { window.testTargetMode = "mismatch"; });
    await page.locator("#repository-refresh-target").click();
    await page.waitForFunction(() => document.querySelector("#repository-target-feedback").textContent.includes("другого клиента"));
    assert.equal(await page.locator("#repository-configure-target").isDisabled(), true);
    await page.evaluate(() => { window.testTargetMode = "ok"; });
    await page.locator("#repository-refresh-target").click();
    await page.waitForFunction(() => document.querySelector("#repository-configure-target").disabled === false);
    await page.locator("#repository-configure-target").click();
    assert.equal(await page.locator("#view-browser").isVisible(), true);
    assert.equal(await page.locator("#browser-tab-deploy").getAttribute("class").then((value) => value.includes("is-current")), true);
    assert.equal(await page.locator("#browser-address-input").inputValue(), "http://127.0.0.1:3002/?clientId=fixture-id");
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    await page.locator("#repository-url").fill("git@github.com:fixture/lms.git");
    assert.ok((await page.locator("#repository-url").boundingBox()).height >= 36);
    await page.locator("#repository-identity-mode").selectOption("file");
    await page.locator("#repository-choose-key").click();
    assert.equal(await page.locator("#repository-identity-file").inputValue(), "C:/fixture/key");
    await page.locator(".repository-check-details > summary").click();
    await page.locator("#repository-check").click();
    await page.waitForFunction(() => document.querySelector("#repository-feedback").dataset.tone === "success");
    assert.equal(await page.locator("#repository-selected-branch").innerText(), "main");
    assert.equal(await page.locator("#repository-revision").innerText(), "a".repeat(40));
    await page.locator("#repository-url").fill("git@github.com:another/project.git");
    assert.equal(await page.locator("#repository-feedback").getAttribute("data-tone"), "neutral");
    await page.locator("#repository-check").click();
    await page.waitForFunction(() => document.querySelector("#repository-feedback").dataset.tone === "success");
    assert.equal(await page.evaluate(() => window.testCalls.lastRepository.url), "git@github.com:another/project.git");
    assert.equal(await page.locator("#repository-branches img").count(), 0);
    await page.locator("#repository-branch").fill("missing");
    assert.equal(await page.locator("#repository-feedback").getAttribute("data-tone"), "neutral");
    await page.locator("#repository-check").click();
    await page.waitForFunction(() => document.querySelector("#repository-feedback").dataset.tone === "error");
    assert.equal(await page.locator("#repository-revision").innerText(), "Не получена");
    await page.locator("#repository-key-details summary").click();
    await page.locator("#repository-create-key").click();
    await page.waitForFunction(() => document.querySelector("#repository-identity-mode").value === "managed");
    assert.equal(await page.locator("#repository-create-key").isDisabled(), true);
    await page.locator("#repository-copy-public-key").click();
    assert.ok((await page.locator("#repository-feedback").innerText()).includes("скопирован"));
    await page.locator("#repository-branch").fill("");
    await page.locator("#source-fetch-button").click();
    await page.waitForFunction(() => document.querySelector(".source-version-panel").dataset.phase === "ready");
    assert.ok((await page.locator("#source-fetch-version").innerText()).includes("12 файлов"));
    assert.equal(await page.locator("#source-fetch-warnings img").count(), 0);
    await remotePassword("fixture-password");
    await deploymentStep("installation");
    await page.locator("#remote-deploy-button").click();
    await page.waitForFunction(() => document.querySelector("#remote-deployment-result").dataset.phase === "building");
    assert.equal(await page.locator("#remote-feedback").innerText(), "Fixture build in progress");
    assert.equal(await page.locator("#remote-deploy-button").isDisabled(), true);
    await page.waitForFunction(() => document.querySelector("#remote-deployment-result").dataset.phase === "succeeded");
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    assert.equal(await page.evaluate(() => window.testCalls.deployment.authenticated), true);
    assert.equal(await page.evaluate(() => window.testCalls.deployment.snapshotId), "fixture-snapshot");
    await remotePassword("fixture-password");
    await deploymentStep("installation");
    await page.locator("#remote-deployment-refresh").click();
    await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("Fixture result checked"));
    await deploymentStep("connection");
    await page.locator("#remote-operation-mode").selectOption("new");
    assert.equal(await page.locator("#new-installation-auto-path").innerText(), "/srv/lms-core/clients/fixture-client");
    await deploymentStep("preparation");
    await page.locator("#new-installation-content-mode").selectOption("");
    await page.locator("#new-installation-prepare").click();
    await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("Выберите наполнение"));
    await page.locator("#new-installation-content-mode").selectOption("source");
    await page.locator("#new-installation-prepare").click();
    await page.waitForFunction(() => document.querySelector("#new-installation-status").dataset.status === "blocked");
    assert.equal(await page.locator("#remote-app-path").inputValue(), "/var/www/fixture");
    assert.ok((await page.locator("#new-installation-database").innerText()).includes("PostgreSQL"));
    assert.equal(await page.locator("#new-installation-client img, #new-installation-blockers img").count(), 0);
    assert.equal(await page.locator("#new-installation-server-check").isEnabled(), true);
    await remotePassword("fixture-password");
    await deploymentStep("preparation");
    await page.locator("#new-installation-server-check").click();
    await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("SSH-проверка новой установки завершена"));
    assert.equal(await page.evaluate(() => window.testCalls.installationChecked.authenticated), true);
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    assert.equal(await page.locator("#new-installation-status").getAttribute("data-status"), "blocked");
    await deploymentStep("connection");
    await page.locator("#remote-username").fill("other-user");
    assert.equal(await page.locator("#remote-password").inputValue(), "");
    assert.equal(await page.locator("#new-installation-server-check").isDisabled(), true);
    assert.equal(await page.locator("#new-installation-summary").isVisible(), false);
    await page.locator("#remote-username").fill("root");
    await page.locator("#remote-host").fill("127.0.0.1");
    await page.locator("#remote-fingerprint").fill("SHA256:" + "A".repeat(43));
    await deploymentStep("preparation");
    await page.locator("#new-installation-content-mode").selectOption("source");
    await page.locator("#new-installation-prepare").click();
    await page.locator("#new-installation-package").click();
    await page.waitForFunction(() => document.querySelector("#new-installation-package-info").textContent.includes("fixture-"));
    assert.match(await page.locator("#new-installation-package-info").innerText(), /тем: 25.*тестов: 9.*вопросов: 89/);
    await page.locator("#new-installation-content-mode").selectOption("empty");
    assert.equal(await page.locator("#new-installation-server-check").isDisabled(), true);
    await page.locator("#new-installation-content-mode").selectOption("source");
    assert.equal(await page.locator("#new-installation-start").isDisabled(), true);
    await remotePassword("fixture-password");
    await deploymentStep("preparation");
    await page.locator("#deployment-environment-tools > summary").click();
    await page.locator("#prepare-server-memory").click();
    await page.waitForFunction(() => document.querySelector("#server-memory-result").textContent.includes("Память готова"));
    assert.equal(await page.evaluate(() => window.testCalls.preparedMemory), true);
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    await page.locator("#prepare-clean-server").click();
    await page.waitForFunction(() => document.querySelector("#server-preparation-result").textContent.includes("Окружение готово"));
    assert.equal(await page.evaluate(() => window.testCalls.preparedClean), true);
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    await page.locator("#new-installation-server-check").click();
    await page.waitForFunction(() => !document.querySelector("#new-installation-start").disabled);
    // Existing Node/old LMS must not conceal missing PostgreSQL in automatic mode.
    await page.evaluate(() => {
      newInstallationPlan.preflight.postgresState = "missing";
      newInstallationPlan.checks.push({ code: "LOCAL_POSTGRES", label: "PostgreSQL", status: "pending", message: "PostgreSQL не установлена. Подготовьте Ubuntu." });
      renderNewInstallationPlan();
    });
    assert.equal(await page.locator("#new-installation-start").isDisabled(), true);
    assert.match(await page.locator("#deployment-next-step").textContent(), /PostgreSQL не установлена/);
    await deploymentStep("installation");
    await page.locator("#install-db-mode").selectOption("password");
    assert.equal(await page.locator("#new-installation-start").isEnabled(), true);
    await page.locator("#install-db-mode").selectOption("local_peer");
    assert.equal(await page.locator("#new-installation-start").isDisabled(), true);
    await page.evaluate(() => { newInstallationPlan.preflight.postgresState = "ready"; newInstallationPlan.checks = []; renderNewInstallationPlan(); });
    await page.locator("#new-installation-start").click();
    await page.waitForFunction(() => document.activeElement.id === "install-client-login");
    assert.equal(await page.evaluate(() => window.testCalls.newStarted), undefined);
    assert.match(await page.locator("#remote-feedback").textContent(), /Логин/);
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    await page.locator("#install-db-mode").selectOption("local_peer");
    assert.equal(await page.locator("#install-db-password").isVisible(), false);
    await page.locator("#install-db-mode").selectOption("password");
    await page.locator("#install-db-mode").selectOption("password");
    await page.locator("#install-db-password").fill("fixture-db-password");
    await page.locator("#install-client-login").fill("fixture.admin");
    await page.locator("#install-client-name").fill("Fixture admin");
    await page.locator("#install-client-password").fill("fixture-client-password");
    await page.locator("#install-system-login").fill("fixture.system");
    await page.locator("#install-system-password").fill("fixture-system-password");
    const beforeEnter = await page.evaluate(() => JSON.stringify([newInstallationPlan.id, newInstallationPlan.package.id]));
    await page.locator("#install-client-name").press("Enter");
    assert.equal(await page.evaluate(() => JSON.stringify([newInstallationPlan.id, newInstallationPlan.package.id])), beforeEnter);
    assert.equal(await page.evaluate(() => window.testCalls.newStarted), undefined);
    assert.equal(await page.locator("#install-client-password").inputValue(), "fixture-client-password");
    await remotePassword("fixture-password");
    await deploymentStep("installation");
    // Let the deadline expire while the operator is filling the form, without real SSH.
    const packageBeforeExpiry = await page.locator("#new-installation-package-info").innerText();
    await page.evaluate(() => {
      window.testInstallationIdentity = [newInstallationPlan.id, newInstallationPlan.package.id];
      newInstallationPlan.preflight.checkedAt = new Date(Date.now() - 10 * 60 * 1000 + 100).toISOString();
      renderNewInstallationPlan();
    });
    await page.waitForFunction(() => document.querySelector("#new-installation-start").disabled);
    assert.match(await page.locator("#new-installation-status").textContent(), /Срок SSH-проверки истёк.*Подготовка.*Проверить сервер/);
    await page.locator("#new-installation-start").dispatchEvent("click");
    await page.waitForFunction(() => document.querySelector("#remote-feedback").textContent.includes("введённые доступы сохранены"));
    assert.equal(await page.evaluate(() => window.testCalls.newStarted), undefined);
    for (const [id, value] of Object.entries({ "remote-password": "fixture-password", "install-db-password": "fixture-db-password", "install-client-password": "fixture-client-password", "install-system-password": "fixture-system-password" })) assert.equal(await page.locator("#" + id).inputValue(), value);
    assert.equal(await page.locator("#new-installation-package-info").textContent(), packageBeforeExpiry);
    await deploymentStep("preparation");
    await page.locator("#new-installation-server-check").click();
    await page.waitForFunction(() => !document.querySelector("#new-installation-start").disabled);
    assert.equal(await page.evaluate(() => JSON.stringify([newInstallationPlan.id, newInstallationPlan.package.id]) === JSON.stringify(window.testInstallationIdentity)), true);
    assert.equal(await page.locator("#install-client-password").inputValue(), "fixture-client-password");
    await deploymentStep("installation");
    await page.locator("#new-installation-start").click();
    await page.waitForFunction(() => document.querySelector("#new-installation-result").textContent.includes("Fixture NEW succeeded"));
    assert.deepEqual(await page.evaluate(() => ({ authenticated: window.testCalls.newStarted.authenticated, database: window.testCalls.newStarted.database, admins: window.testCalls.newStarted.admins })), { authenticated: true, database: true, admins: true });
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    for (const id of ["install-db-password", "install-client-password", "install-system-password"]) assert.equal(await page.locator("#" + id).inputValue(), "");
    assert.equal(await page.locator("#new-installation-start").isDisabled(), true);
    await remotePassword("fixture-password");
    await deploymentStep("installation");
    await page.locator("#new-installation-refresh").click();
    await page.waitForFunction(() => document.querySelector("#new-installation-result").textContent.includes("Fixture NEW checked"));
    await deploymentStep("access");
    assert.equal(await page.locator("#ip-publication-panel").isVisible(), true);
    await page.locator("#ip-publication-panel > summary").click();
    await page.locator("#ip-publication-start").click();
    await page.waitForFunction(() => document.querySelector("#ip-publication-result").textContent.includes("HTTP без шифрования"));
    assert.deepEqual(await page.evaluate(() => ({ authenticated: window.testCalls.ipPublication.authenticated, checkOnly: window.testCalls.ipPublication.checkOnly })), { authenticated: true, checkOnly: false });
    assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
    await page.locator("#ip-publication-check").click();
    await page.waitForFunction(() => window.testCalls.ipPublication.checkOnly);
    await page.locator("#ip-publication-open").click();
    assert.equal(await page.evaluate(() => window.testCalls.openedUrl), "http://127.0.0.1");
    if (process.env.CORE_TEST_HTTPS === "1") {
      assert.equal(await page.locator("#ip-publication-https").isEnabled(), true);
      await page.evaluate(() => { window.testHttpsCancel = true; });
      await page.locator("#ip-publication-https").click();
      await page.waitForFunction(() => document.getElementById("remote-feedback").textContent.includes("отменен"));
      assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
      await page.evaluate(() => { window.testHttpsCancel = false; window.testHttpsFail = true; });
      await page.locator("#ip-publication-https").click();
      await page.waitForFunction(() => document.getElementById("ip-publication-result").textContent.includes("не отдает проверочный файл"));
      assert.match(await page.locator("#ip-publication-result").textContent(), /Прежний конфиг восстановлен/);
      await page.locator("#ip-publication-check").click();
      await page.waitForFunction(() => !document.getElementById("ip-publication-https").disabled);
      await page.evaluate(() => { window.testHttpsFail = false; window.testHttpsWait = true; });
      await page.locator("#ip-publication-https").click();
      await page.waitForFunction(() => Boolean(window.testHttpsRelease));
      assert.equal(await page.locator("#ip-publication-check").isDisabled(), true);
      await page.evaluate(() => { window.testHttpsWait = false; window.testHttpsRelease(); });
      await page.waitForFunction(() => document.getElementById("ip-publication-result").textContent.includes("Сертификат до:"));
      assert.equal(await page.locator("#ip-publication-start").isVisible(), false);
      assert.match(await page.locator("#ip-publication-result").textContent(), /таймер включен/);
      await page.locator("#ip-publication-open").click();
      assert.match(await page.evaluate(() => window.testCalls.openedUrl), /^https:\/\//);
      await page.evaluate(() => { window.testSavedPublication = { ...window.testSavedPublication, phase: "needs_attention", errorCode: "TLS_CERTIFICATE_EXPIRED", expiresAt: new Date(Date.now() - 86400000).toISOString() }; });
      await page.locator("#ip-publication-check").click();
      await page.waitForFunction(() => document.getElementById("ip-publication-result").textContent.includes("Срок сертификата истек"));
      assert.equal(await page.locator("#ip-publication-open").isDisabled(), true);
      assert.equal(await page.locator("#ip-publication-https").isEnabled(), true);
      assert.match(await page.locator("#ip-publication-result").textContent(), /https:\/\//);
      await page.locator("#ip-publication-https").click();
      await page.waitForFunction(() => !document.getElementById("ip-publication-open").disabled);
      await page.evaluate(() => { document.getElementById("ai-configuration-panel").open = false; document.getElementById("mail-configuration-panel").open = false; });
      for (const theme of ["graphite", "porcelain"]) {
        await page.evaluate(theme => persistSettingsPatch({ theme }), theme);
        for (const width of [1366, 900]) {
          await page.setViewportSize({ width, height: 900 });
          await page.locator("#ip-publication-panel").scrollIntoViewIfNeeded();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
          await page.screenshot({ path: path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `https-${theme}-${width}.png`) });
        }
      }
      assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
      assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-password")), false);
      assert.equal((await page.locator("#deployment-history").textContent()).includes("fixture-password"), false);
      assert.equal(await page.evaluate(() => window.testCalls.https.authenticated), true);
      assert.deepEqual(pageErrors, []); console.log("HTTPS workflow UI accepted: confirmation cancel, failure, busy, expiry/repair, exact HTTPS link, renewal and secret retention; no external requests"); return;
    }
    if (process.env.CORE_TEST_MAIL === "1") {
      assert.equal(await page.locator("#mail-configuration-panel").isVisible(), true);
      await page.locator("#mail-configuration-panel > summary").click();
      await page.locator("#mail-password").fill("fixture-smtp-secret");
      await page.locator("#mail-configuration-apply").click();
      assert.equal(await page.evaluate(() => window.testCalls.mail), undefined);
      assert.equal(await page.evaluate(() => document.activeElement.id), "mail-user");
      for (const [id, value] of Object.entries({ "mail-user": "sender@example.invalid", "mail-host": "smtp.example.invalid", "mail-port": "465" })) await page.locator("#" + id).fill(value);
      assert.equal(await page.locator("#mail-password").getAttribute("type"), "password");
      await page.getByRole("button", { name: "Настройки", exact: true }).click();
      await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
      await page.waitForFunction(() => !document.getElementById("mail-configuration-check").disabled); await deploymentStep("access");
      assert.equal(await page.locator("#mail-password").inputValue(), "fixture-smtp-secret");
      await page.getByRole("button", { name: "Клиенты", exact: true }).click();
      assert.equal(await page.locator("body").getAttribute("data-workspace-view"), "repository");
      assert.equal(await page.locator("#mail-password").inputValue(), "fixture-smtp-secret");
      await remotePassword("fixture-password"); await deploymentStep("access");
      await page.evaluate(() => { window.testMailFailure = true; }); await page.locator("#mail-configuration-apply").click();
      await page.waitForFunction(() => document.getElementById("mail-configuration-result").textContent.includes("MAIL_CHANGE_ROLLED_BACK"));
      assert.equal(await page.locator("#mail-password").inputValue(), "fixture-smtp-secret");
      assert.equal(await page.locator("#deployment-operation-state").getAttribute("data-tone"), "error");
      await page.evaluate(() => { window.testMailFailure = false; window.testMailCancel = true; }); await page.locator("#mail-configuration-apply").click();
      await page.waitForFunction(() => document.getElementById("deployment-operation-state").textContent === "Отменено");
      assert.equal(await page.locator("#mail-password").inputValue(), "fixture-smtp-secret");
      await page.evaluate(() => { window.testMailCancel = false; }); await page.locator("#mail-configuration-apply").click();
      await page.waitForFunction(() => document.getElementById("mail-password").value === "");
      assert.deepEqual(await page.evaluate(() => ({ authenticated: window.testCalls.mail.authenticated, passwordMatches: window.testCalls.mail.passwordMatches, action: window.testCalls.mail.action })), { authenticated: true, passwordMatches: true, action: "apply" });
      assert.equal(await page.evaluate(() => mailConfigurationController.dirty()), false);
      assert.ok((await page.locator("#mail-configuration-result").textContent()).includes("Поддержка на сайте: sender@example.invalid"));
      await page.locator("#mail-configuration-check").click(); await page.waitForFunction(() => window.testCalls.mail.action === "check");
      assert.equal(await page.locator("#mail-user").inputValue(), "sender@example.invalid");
      assert.equal(await page.locator("#mail-password").inputValue(), "");
      assert.equal(await page.locator("#mail-configuration-test").isDisabled(), true);
      await page.locator("#mail-test-recipient").fill("recipient@example.invalid");
      await page.evaluate(() => { window.testMailFailure = true; }); await page.locator("#mail-configuration-test").click();
      await page.waitForFunction(() => document.getElementById("mail-configuration-result").textContent.includes("SMTP отклонил вход"));
      assert.equal(await page.locator("#deployment-operation-state").getAttribute("data-tone"), "error");
      await page.evaluate(() => { window.testMailFailure = false; }); await page.locator("#mail-configuration-test").click();
      await page.waitForFunction(() => document.getElementById("mail-configuration-result").textContent.includes("SMTP-сервер принял"));
      assert.equal(await page.evaluate(() => window.testCalls.mail.recipient), "recipient@example.invalid");
      await page.locator("#mail-port").fill("587"); await page.locator("#mail-secure").selectOption("false");
      assert.equal(await page.locator("#mail-starttls-warning").isVisible(), true);
      assert.equal(await page.locator("#mail-configuration-test").isDisabled(), true);
      await page.locator("#mail-configuration-apply").click(); await page.waitForFunction(() => !mailConfigurationController.dirty());
      assert.equal(await page.evaluate(() => window.testCalls.mail.passwordMatches), false);
      assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
      for (const id of ["mail-configuration-result", "deployment-history"]) assert.equal((await page.locator("#" + id).textContent()).includes("fixture-smtp-secret"), false);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => String(localStorage.getItem(key)).includes("fixture-smtp-secret"))), false);
      for (const theme of ["graphite", "porcelain"]) {
        await page.evaluate(theme => persistSettingsPatch({ theme }), theme);
        for (const width of [1366, 900]) { await page.setViewportSize({ width, height: 900 }); assert.ok(await page.locator("#view-repository").evaluate(el => el.scrollWidth <= el.clientWidth + 1)); }
        await page.setViewportSize({ width: 1366, height: 900 }); await page.locator("#mail-configuration-panel").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `mail-configuration-${theme}.png`) });
      }
      assert.deepEqual(pageErrors, []);
      console.log("Mail UI accepted: installed gate, validation, retained draft, rollback/cancellation, masked password, no password in result/history/storage, read-only check, explicit single-recipient test, blank-password reuse, two themes/two widths. Mock bridge only.");
      return;
    }
    if (process.env.CORE_TEST_AI === "1") {
      assert.equal(await page.locator("#ai-configuration-panel").isVisible(), true);
      await page.locator("#ai-api-key").fill("fixture-ai-secret");
      await page.locator("#ai-configuration-apply").click();
      assert.equal(await page.evaluate(() => window.testCalls.ai), undefined);
      assert.equal(await page.evaluate(() => document.activeElement.id), "ai-project-id");
      for (const [id, value] of Object.entries({ "ai-project-id": "fixture-project", "ai-prompt-id": "fixture-prompt", "ai-vector-store-id": "fixture-vector" })) await page.locator("#" + id).fill(value);
      await page.locator("#ai-prompt-id").fill("0001");
      await page.locator("#ai-configuration-apply").click();
      assert.equal(await page.evaluate(() => window.testCalls.ai), undefined);
      assert.equal(await page.evaluate(() => document.activeElement.id), "ai-prompt-id");
      assert.match(await page.locator("#remote-feedback").textContent(), /Номер клиента/);
      await page.locator("#ai-prompt-id").fill("fixture-prompt");
      // Navigation must retain the live draft through a same-client reload of profile/state.
      await page.getByRole("button", { name: "Настройки", exact: true }).click();
      await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
      await page.waitForFunction(() => document.getElementById("ai-configuration-check").disabled === false);
      await deploymentStep("access");
      assert.equal(await page.locator("#ai-api-key").inputValue(), "fixture-ai-secret");
      assert.equal(await page.locator("#ai-project-id").inputValue(), "fixture-project");
      await page.getByRole("button", { name: "Клиенты", exact: true }).click();
      assert.equal(await page.locator("body").getAttribute("data-workspace-view"), "repository");
      assert.equal(await page.locator("#ai-api-key").inputValue(), "fixture-ai-secret");
      await remotePassword("fixture-password"); await deploymentStep("access");
      await page.evaluate(() => { window.testAiFailure = true; });
      await page.locator("#ai-configuration-apply").click();
      await page.waitForFunction(() => document.getElementById("ai-configuration-result").textContent.includes("AI_CHANGE_ROLLED_BACK"));
      assert.equal(await page.locator("#ai-api-key").inputValue(), "fixture-ai-secret");
      assert.equal(await page.locator("#deployment-operation-state").getAttribute("data-tone"), "error");
      await page.evaluate(() => { window.testAiFailure = false; window.testAiCancel = true; });
      await page.locator("#ai-configuration-apply").click();
      await page.waitForFunction(() => document.getElementById("deployment-operation-state").textContent === "Отменено");
      assert.equal(await page.locator("#ai-api-key").inputValue(), "fixture-ai-secret");
      await page.evaluate(() => { window.testAiCancel = false; });
      await page.locator("#ai-configuration-apply").click();
      await page.waitForFunction(() => document.getElementById("ai-api-key").value === "");
      await page.waitForFunction(() => document.getElementById("deployment-operation-state").textContent === "ИИ: подключение не проверено");
      assert.deepEqual(await page.evaluate(() => ({ authenticated: window.testCalls.ai.authenticated, tokenMatches: window.testCalls.ai.tokenMatches, checkOnly: window.testCalls.ai.checkOnly })), { authenticated: true, tokenMatches: true, checkOnly: false });
      assert.equal(await page.locator("#remote-password").inputValue(), "fixture-password");
      assert.equal(await page.evaluate(() => aiConfigurationController.dirty()), false);
      await page.locator("#ai-configuration-check").click();
      await page.waitForFunction(() => window.testCalls.ai.checkOnly);
      const result = await page.locator("#ai-configuration-result").textContent();
      assert.equal(result.includes("fixture-ai-secret"), false); assert.match(result, /не подтверждаются/);
      assert.equal((await page.locator("#deployment-history").textContent()).includes("fixture-ai-secret"), false);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => String(localStorage.getItem(key)).includes("fixture-ai-secret"))), false);
      await page.locator("#ai-vector-store-id").fill("0001");
      await page.locator("#ai-configuration-provision").click();
      await page.waitForFunction(() => document.getElementById("ai-vector-store-id").value === "fixture-auto-index");
      assert.deepEqual(await page.evaluate(() => ({ authenticated: window.testCalls.aiProvision.authenticated, tokenEmpty: window.testCalls.aiProvision.tokenEmpty })), { authenticated: true, tokenEmpty: true });
      assert.equal(await page.evaluate(() => aiConfigurationController.dirty()), false);
      assert.match(await page.locator("#ai-configuration-result").textContent(), /ID базы применен/);
      await page.locator("#ai-configuration-provision").click();
      await page.waitForFunction(() => document.getElementById("ai-configuration-result").textContent.includes("повторно использована своя"));
      assert.equal(await page.locator("#deployment-operation-state").textContent(), "ИИ: подключение не проверено");
      for (const theme of ["graphite", "porcelain"]) {
        await page.evaluate(theme => persistSettingsPatch({ theme }), theme);
        for (const width of [1366, 900]) { await page.setViewportSize({ width, height: 900 }); assert.ok(await page.locator("#view-repository").evaluate(el => el.scrollWidth <= el.clientWidth + 1)); }
        await page.setViewportSize({ width: 1366, height: 900 }); await page.locator("#ai-configuration-panel").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `ai-configuration-${theme}.png`) });
      }
      assert.deepEqual(pageErrors, []);
      console.log("AI UI accepted: installed-client gate, local validation, retained draft, cancelled/failed apply, masked input, secret-free result/history/storage, server config check, two themes/two widths. Mock bridge only.");
      return;
    }
    if (process.env.CORE_TEST_DEPLOYMENT === "1") {
      assert.equal(await page.locator(".deployment-console").count(), 1);
      for (const id of ["remote-feedback", "remote-candidate", "remote-inventory", "remote-preflight-result", "new-installation-status", "new-installation-package-info", "server-memory-result", "server-preparation-result", "new-installation-result", "ip-publication-result", "remote-deployment-result"]) assert.equal(await page.locator("#" + id).evaluate(el => Boolean(el.closest(".deployment-console"))), true, `${id} must stay in the same console`);
      await page.evaluate(() => { window.originalInstallationForUiTest = structuredClone(newInstallationState); newInstallationState.phase = "build"; newInstallationState.message = "Fixture: сборка на сервере"; renderNewInstallationState(); renderNewInstallationPlan(); });
      assert.equal(await page.locator("#deployment-operation-state").getAttribute("data-tone"), "running");
      assert.equal(await page.locator("#new-installation-start").isDisabled(), true);
      await page.evaluate(() => { newInstallationState.phase = "failed"; newInstallationState.message = "Fixture: ошибка сборки"; renderNewInstallationState(); });
      assert.equal(await page.locator("#deployment-operation-state").getAttribute("data-tone"), "error");
      await page.evaluate(() => { const token = deploymentWorkflow.begin(); deploymentWorkflow.progress("access", { id: "ui-failed-publication", phase: "failed" }); deploymentWorkflow.end(token, true); });
      assert.equal(await page.locator("#deployment-operation-state").getAttribute("data-tone"), "error");
      await page.evaluate(() => { newInstallationState = window.originalInstallationForUiTest; renderNewInstallationState(); renderNewInstallationPlan(); });
      await deploymentStep("preparation");
      const restoredStage = await page.evaluate(() => {
        const checkedAt = newInstallationPlan.preflight.checkedAt;
        newInstallationPlan.preflight.checkedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString(); renderNewInstallationPlan();
        deploymentWorkflow.progress("access", { id: "saved-publication-result", phase: "succeeded" });
        const result = { title: document.getElementById("deployment-result-title").textContent, tone: document.getElementById("deployment-operation-state").dataset.tone };
        newInstallationPlan.preflight.checkedAt = checkedAt; renderNewInstallationPlan(); return result;
      });
      assert.deepEqual(restoredStage, { title: "Пакет и готовность сервера", tone: "pending" });
      await page.evaluate(() => { const token = deploymentWorkflow.begin(); deploymentWorkflow.end(token, true, true); });
      assert.equal(await page.locator("#deployment-operation-state").textContent(), "Отменено");
      const history = await page.locator("#deployment-history").textContent();
      for (const secret of ["fixture-password", "fixture-db-password", "fixture-client-password", "fixture-system-password", "fixture-key-passphrase"]) assert.equal(history.includes(secret), false);
      for (const theme of ["graphite", "porcelain"]) {
        await page.evaluate(theme => persistSettingsPatch({ theme }), theme);
        for (const stage of ["connection", "preparation", "installation", "access"]) {
          await deploymentStep(stage);
          assert.equal(await page.locator("[data-deploy-pane]:visible").count(), 1);
          for (const width of [1366, 900]) {
            await page.setViewportSize({ width, height: 900 });
            assert.ok(await page.locator("#view-repository").evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${stage}/${theme}/${width} overflow`);
          }
          await page.setViewportSize({ width: 1366, height: 900 });
          await page.locator("#remote-connection-details").scrollIntoViewIfNeeded();
          const form = await page.locator("#remote-target-form").boundingBox(), output = await page.locator(".deployment-console").boundingBox();
          assert.ok(output.x >= form.x + form.width - 1, "On desktop output must remain to the right of the actions");
          await page.screenshot({ path: path.join(process.env.CORE_TEST_OUTPUT || os.tmpdir(), `deployment-${theme}-${stage}.png`) });
        }
      }
      await page.evaluate(() => { for (let i = 0; i < 90; i++) deploymentWorkflow.progress("installation", { id: "history-bound", phase: i % 2 ? "health" : "build" }); });
      assert.equal(await page.locator("#deployment-history > li").count(), 60);
      await page.evaluate(() => { window.testInvalidPreparationCalled = false; const original = launcherApi.prepareInstallation; launcherApi.prepareInstallation = (...args) => { window.testInvalidPreparationCalled = true; return original(...args); }; document.getElementById("remote-host").value = ""; });
      await deploymentStep("preparation");
      await page.locator("#new-installation-prepare").click();
      assert.equal(await page.locator('[data-deploy-pane="connection"]').isVisible(), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), "remote-host");
      assert.equal(await page.evaluate(() => window.testInvalidPreparationCalled), false);
      assert.deepEqual(pageErrors, []);
      console.log("Deployment UX accepted: staged actions, one output console, real mock progress/errors, retained secrets, bounded safe history, hidden-field validation, two themes/two widths. No external SSH.");
      return;
    }
    await remotePassword("fixture-password");
    await deploymentStep("access");
    await page.locator("#new-installation-open-lms").click();
    await page.waitForFunction(() => document.querySelector("#browser-tab-remote").classList.contains("is-current"));
    assert.equal(await page.evaluate(() => window.testCalls.viewerOpened), true);
    assert.equal(await page.locator("#native-lms-view-host").isVisible(), true);
    assert.equal(await page.locator("#embedded-panel-frame").isVisible(), false);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layouts = await page.evaluate(async () => {
      const before = window.testCalls.viewerLayouts;
      for (let i = 0; i < 30; i++) syncLmsViewerBounds();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { before, after: window.testCalls.viewerLayouts };
    });
    assert.equal(layouts.after, layouts.before);
    await page.locator("#close-lms-viewer").click();
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    assert.equal(await page.locator("#view-repository").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: path.join(os.tmpdir(), "lms-core-new-installation-test.png") });
    await deploymentStep("connection");
    await page.locator("#remote-operation-mode").selectOption("update");
    await page.locator("#repository-url").fill("git@github.com:third/project.git");
    assert.ok((await page.locator("#source-fetch-feedback").innerText()).includes("другого источника"));
    await deploymentStep("installation");
    await page.locator("#remote-deploy-button").click();
    assert.ok((await page.locator("#remote-feedback").innerText()).includes("Источник или ветка изменены"));
    assert.equal(await page.locator("#view-repository").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: path.join(os.tmpdir(), "lms-core-repository-test.png") });
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator('[data-settings-tab="system"]').click();
    await page.locator("#start-all-button").click();
    await page.waitForFunction(() => document.querySelector("#view-browser").classList.contains("is-current"));
    assert.equal(await page.locator("#start-all-button").innerText(), "Открыть панель клиентов");
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator('[data-settings-tab="system"]').click();
    await page.locator("#start-all-button").click();
    assert.equal(await page.evaluate(() => window.testCalls.startAll), 1);
    await page.evaluate(async () => {
      const lms = window.testStatuses.find((item) => item.id === "lms-web");
      lms.healthState = "unhealthy"; lms.message = "Порт занят другим приложением <img src=x>";
      await refreshStatuses(); await setBrowserMode("preview");
    });
    assert.equal(await page.locator("#embedded-panel-frame").isVisible(), false);
    assert.equal(await page.locator("#git-preview-controls").isVisible(), true);
    assert.equal(await page.locator("#embedded-panel-offline").isVisible(), false, "Git preview is independent of the retired renderer's health");
    assert.equal(await page.locator(".service-problem img").count(), 0);
    await page.evaluate(async () => { window.testStatuses.find((item) => item.id === "lms-web").healthState = "healthy"; await refreshStatuses(); await setBrowserMode("preview"); });
    assert.equal(await page.locator("#embedded-panel-frame").isVisible(), false);
    await page.locator("#git-preview-start").click();
    assert.ok((await page.locator("#git-preview-status").innerText()).includes("получите код"));
    assert.equal(await page.evaluate(() => window.testCalls.gitPreviewStart), undefined);
    await page.evaluate(() => window.testGitPreviewState({ phase: "ready", clientId: getStoredPreviewClientId(), revision: "a".repeat(40), repositoryUrl: "git@github.com:fixture/lms.git", url: "http://127.0.0.1:23001", message: "Git-LMS готова" }));
    await page.waitForFunction(() => window.testCalls.gitPreviewShown === true);
    assert.ok((await page.locator("#git-preview-version").innerText()).includes("aaaaaaaaaaaa"));
    await page.locator("#git-preview-system").click();
    assert.equal(await page.evaluate(() => window.testCalls.gitPreviewRole), "system");
    await page.locator("#reload-embedded-panel-button").click();
    assert.equal(await page.evaluate(() => window.testCalls.gitPreviewReloaded), true);
    await page.locator("#git-preview-stop").click();
    assert.equal(await page.evaluate(() => window.testCalls.gitPreviewStopped), true);
    await page.evaluate(() => setBrowserMode("deploy"));
    const readyDeployFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame() && frame.url().startsWith("http://127.0.0.1:3002/"));
    await readyDeployFrame.waitForFunction(() => window.fixtureContextReady === true);
    await page.getByRole("button", { name: "Развернуть просмотр" }).click();
    assert.equal(await page.locator(".side-rail").isVisible(), false);
    await page.getByRole("button", { name: "Обычный режим" }).click();
    await page.getByRole("button", { name: "LMS", exact: true }).click();
    assert.equal(await page.locator("body").getAttribute("data-workspace-view"), "lms");
    await page.getByRole("button", { name: "Выбрать клиента" }).click();
    await page.waitForSelector(".modal-client-button");
    assert.equal(await page.locator(".modal-client-name img").count(), 0);
    await page.locator(".modal-client-button").click();
    await page.locator("#preview-client-modal").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Обычный режим" }).click();
    await page.getByRole("button", { name: "База данных", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#database-caption").textContent.includes("fixture"));
    assert.equal(await page.locator("#database-preview-table img").count(), 0);
    const databaseRace = await page.evaluate(async () => {
      const retainedButton = document.querySelector('[data-table-name="users"]');
      const requests = [];
      window.testDatabaseHandler = (table) => new Promise((resolve, reject) => requests.push({ table, resolve, reject }));
      const tables = [{ name: "clients", rows: 2, totalBytes: 100 }, { name: "courses", rows: 3, totalBytes: 100 }, { name: "users", rows: 1, totalBytes: 100 }];
      const result = (table) => ({ database: "fixture", selectedTable: table, tables, rows: [{ table }] });
      const first = loadPostgresSnapshot("users");
      const skipped = loadPostgresSnapshot("courses");
      const last = loadPostgresSnapshot("clients");
      const initialCount = requests.length;
      requests[0].resolve(result("users"));
      await first;
      await skipped;
      while (requests.length < 2) await Promise.resolve();
      const onlyLatestQueued = requests.length === 2 && requests[1].table === "clients";
      const staleIgnored = document.querySelector("#database-selected-table").textContent === "clients";
      requests[1].resolve(result("clients"));
      await last;
      const retained = document.querySelector('[data-table-name="users"]') === retainedButton;
      const selected = activeDatabaseTable;
      const failing = loadPostgresSnapshot("users");
      requests[2].reject(new Error("Fixture database unavailable"));
      await failing;
      const failedListRetained = document.querySelectorAll(".database-table-button").length === 3;
      const staleRowsCleared = !document.querySelector("#database-preview-table").textContent.includes("clients");
      const retry = loadPostgresSnapshot("users");
      requests[3].resolve(result("users"));
      await retry;
      const cell = document.querySelector("#database-preview-table td");
      const refresh = loadPostgresSnapshot("users");
      requests[4].resolve(result("users"));
      await refresh;
      const unchangedRowsRetained = document.querySelector("#database-preview-table td") === cell;
      delete window.testDatabaseHandler;
      return { initialCount, onlyLatestQueued, staleIgnored, retained, selected, failedListRetained, staleRowsCleared, unchangedRowsRetained, loading: document.querySelector("#database-preview-table").getAttribute("aria-busy") };
    });
    assert.deepEqual(databaseRace, { initialCount: 1, onlyLatestQueued: true, staleIgnored: true, retained: true, selected: "clients", failedListRetained: true, staleRowsCleared: true, unchangedRowsRetained: true, loading: "false" });
    const logRace = await page.evaluate(async () => {
      const requests = [];
      window.testLogHandler = (path) => new Promise((resolve, reject) => requests.push({ path, resolve, reject }));
      const first = showLog("C:\\fixture\\first.log", "First log");
      const same = refreshActiveLog();
      await Promise.resolve();
      const initialCount = requests.length;
      const last = showLog("C:\\fixture\\last.log", "Last log");
      requests[0].resolve("Stale first log");
      await first;
      while (requests.length < 2) await Promise.resolve();
      const content = Array.from({ length: 200 }, (_, index) => `Last log row ${index}`).join("\n");
      requests[1].resolve(content);
      await last;
      await same;
      const staleIgnored = logPanelContent.textContent === content && activeLogPath.endsWith("last.log");
      const retainedText = logPanelContent.firstChild;
      const unchanged = refreshActiveLog();
      await Promise.resolve();
      requests[2].resolve(content);
      await unchanged;
      const unchangedNode = logPanelContent.firstChild === retainedText;
      logPanelContent.style.height = "120px";
      logPanelContent.style.minHeight = "120px";
      logPanelContent.style.maxHeight = "120px";
      logPanelContent.scrollTop = 24;
      const previousScroll = logPanelContent.scrollTop;
      const appended = refreshActiveLog();
      await Promise.resolve();
      requests[3].resolve(content + "\nNew line");
      await appended;
      const scrollRetained = logPanelContent.scrollTop === previousScroll;
      const appendNode = logPanelContent.firstChild === retainedText;
      const range = document.createRange();
      range.setStart(retainedText, 0); range.setEnd(retainedText, 4);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const readsBeforeSelection = requests.length;
      await refreshActiveLog();
      const selectionPaused = requests.length === readsBeforeSelection && document.querySelector("#log-update-status").dataset.tone === "paused" && selection.toString() === "Last";
      selection.removeAllRanges();
      const resumed = refreshActiveLog();
      await Promise.resolve();
      requests[4].resolve(content + "\nNew line\nResumed");
      await resumed;
      const failed = refreshActiveLog();
      await Promise.resolve();
      requests[5].reject(new Error("Fixture read failure"));
      await failed.catch(() => {});
      const errorVisible = document.querySelector("#log-update-status").dataset.tone === "error";
      const retry = refreshActiveLog();
      await Promise.resolve();
      requests[6].resolve("Recovered log");
      await retry;
      const recovered = logPanelContent.textContent === "Recovered log" && activeLogRead === null;
      logPanelContent.style.removeProperty("height"); logPanelContent.style.removeProperty("min-height"); logPanelContent.style.removeProperty("max-height");
      delete window.testLogHandler;
      return { initialCount, staleIgnored, unchangedNode, scrollRetained, appendNode, selectionPaused, errorVisible, recovered };
    });
    assert.deepEqual(logRace, { initialCount: 1, staleIgnored: true, unchangedNode: true, scrollRetained: true, appendNode: true, selectionPaused: true, errorVisible: true, recovered: true });
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator('[data-theme-choice="sand"]').click();
    assert.equal(await page.locator("body").getAttribute("data-theme"), "sand");
    assert.equal(await page.locator("[data-theme-choice]").count(), 8);
    await page.locator("#density-select").selectOption("compact");
    await page.locator("#text-size-select").selectOption("large");
    await page.locator("#sidebar-width-select").selectOption("narrow");
    await page.locator("#reduced-motion-checkbox").check();
    assert.equal(await page.locator("body").getAttribute("data-density"), "compact");
    assert.equal(await page.locator("body").getAttribute("data-text-size"), "large");
    assert.equal(await page.locator("body").getAttribute("data-sidebar-width"), "narrow");
    assert.equal(await page.locator("body").getAttribute("data-reduced-motion"), "true");
    await page.locator('[data-settings-tab="behavior"]').click();
    assert.equal(await page.locator('[data-settings-group="appearance"]').isVisible(), false);
    await page.locator("#status-interval-select").selectOption("30000");
    await page.locator('[data-settings-tab="logs"]').click();
    await page.locator("#auto-refresh-logs-checkbox").uncheck();
    assert.equal(await page.evaluate(() => window.testIntervals.some((item) => item.delay === 30000)), true);
    await page.getByRole("button", { name: "Журнал", exact: true }).click();
    const noLogPolling = await page.evaluate(async () => {
      const before = window.testCalls.logReads;
      for (const timer of window.testIntervals.filter((item) => item.delay === 2500)) timer.callback();
      await Promise.resolve();
      return window.testCalls.logReads === before;
    });
    assert.equal(noLogPolling, true);
    const logReadsBeforeManual = await page.evaluate(() => window.testCalls.logReads);
    await page.locator("#refresh-button").click();
    assert.ok(await page.evaluate(() => window.testCalls.logReads) > logReadsBeforeManual);
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.evaluate(() => { window.testFailPreferences = true; });
    await page.locator('[data-theme-choice="ocean"]').click();
    await page.waitForFunction(() => document.querySelector("#settings-save-status").dataset.tone === "error");
    await page.evaluate(() => { window.testFailPreferences = false; });
    await page.locator("#retry-settings-save").click();
    await page.waitForFunction(() => document.querySelector("#settings-save-status").dataset.tone === "saved");
    assert.equal(await page.evaluate(() => window.testCalls.savedPreferences.theme), "ocean");
    await page.locator("#reset-appearance-button").click();
    await page.evaluate(() => preferencesWriteQueue);
    assert.equal(await page.evaluate(() => window.testCalls.savedPreferences.theme), "midnight");
    assert.equal(await page.evaluate(() => window.testCalls.savedPreferences.statusInterval), 30000);
    assert.equal(await page.evaluate(() => window.testCalls.savedPreferences.autoRefreshLogs), false);
    await page.locator('[data-theme-choice="sand"]').click();
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    await page.screenshot({ path: path.join(os.tmpdir(), "lms-core-repository-sand-test.png") });
    assert.deepEqual(pageErrors, []);
    await deploymentStep("connection");
    await page.locator("#remote-clear-credentials").click();
    assert.equal(await page.locator("#remote-password").inputValue(), "");
    await page.locator("#remote-auth-mode").selectOption("key");
    await page.locator("#remote-passphrase").fill("fixture-key-passphrase");
    await page.locator("#remote-clear-credentials").click();
    assert.equal(await page.locator("#remote-passphrase").inputValue(), "");
    await page.locator("#remote-auth-mode").selectOption("password");
    await remotePassword("fixture-password");
    await page.locator("#remote-auth-mode").selectOption("key");
    assert.equal(await page.locator("#remote-password").inputValue(), "");
    await page.locator("#remote-passphrase").fill("fixture-key-passphrase");
    await page.locator("#remote-host").fill("changed.fixture.example");
    assert.equal(await page.locator("#remote-passphrase").inputValue(), "");
    await page.locator("#remote-auth-mode").selectOption("password");
    await page.locator("#remote-password").fill("fixture-password");
    assert.ok(!(await page.evaluate(() => { try { return JSON.stringify(localStorage); } catch { return "fixture storage unavailable"; } })).includes("fixture-password"));
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    assert.equal(await page.locator("#remote-password").inputValue(), "");
    console.log("UI smoke passed: new/update separation, installation plan and invalidation, session-only SSH credential reuse/error retention/scope+manual cleanup, confirmed swap command bridge, source replacement, client/profile checks, deploy-panel navigation, refs, key workflow, no duplicate local start, escaped content, database and themes. Mock bridge only; real iframe requests blocked.");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
