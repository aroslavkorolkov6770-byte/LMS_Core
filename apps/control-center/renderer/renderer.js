const servicesGrid = document.getElementById("services-grid");
const summaryText = document.getElementById("summary-text");
const diagnosticsText = document.getElementById("diagnostics-text");
const logPanelCaption = document.getElementById("log-panel-caption");
const logPanelContent = document.getElementById("log-panel-content");
const embeddedPanelFrame = document.getElementById("embedded-panel-frame");
const embeddedPanelOffline = document.getElementById("embedded-panel-offline");
const embeddedPanelOfflineTitle = document.getElementById("embedded-panel-offline-title");
const embeddedPanelOfflineText = document.getElementById("embedded-panel-offline-text");
const browserAddressInput = document.getElementById("browser-address-input");
const browserClientIdInput = document.getElementById("browser-client-id-input");
const browserTabDeploy = document.getElementById("browser-tab-deploy");
const browserTabPreview = document.getElementById("browser-tab-preview");
const reloadEmbeddedPanelButton = document.getElementById("reload-embedded-panel-button");
const choosePreviewClientButton = document.getElementById("choose-preview-client-button");
const toggleBrowserFocusButton = document.getElementById("toggle-browser-focus-button");
const startEmbeddedPanelButton = document.getElementById("start-embedded-panel-button");
const previewClientModal = document.getElementById("preview-client-modal");
const previewClientModalCaption = document.getElementById("preview-client-modal-caption");
const closePreviewClientModalButton = document.getElementById("close-preview-client-modal-button");
const previewClientSearchInput = document.getElementById("preview-client-search-input");
const previewClientList = document.getElementById("preview-client-list");
const overviewServiceStrip = document.getElementById("overview-service-strip");
const overviewNextStep = document.getElementById("overview-next-step");
const overviewNextStepNote = document.getElementById("overview-next-step-note");
const overviewOperatorChecklist = document.getElementById("overview-operator-checklist");
const statServicesOnline = document.getElementById("stat-services-online");
const statCurrentView = document.getElementById("stat-current-view");
const statPreviewClient = document.getElementById("stat-preview-client");
const defaultViewSelect = document.getElementById("default-view-select");
const autoFocusPreviewCheckbox = document.getElementById("auto-focus-preview-checkbox");
const rememberLastViewCheckbox = document.getElementById("remember-last-view-checkbox");
const openLogViewLauncherButton = document.getElementById("open-log-view-launcher-button");
const databaseCaption = document.getElementById("database-caption");
const databaseTableList = document.getElementById("database-table-list");
const databaseSelectedTable = document.getElementById("database-selected-table");
const databaseSelectedTableMeta = document.getElementById("database-selected-table-meta");
const databasePreviewTable = document.getElementById("database-preview-table");
const refreshDatabaseButton = document.getElementById("refresh-database-button");
const openDatabasePgAdminButton = document.getElementById("open-database-pgadmin-button");
const template = document.getElementById("service-card-template");

const launcherBridge = window.launcherApi ?? null;
const viewLabels = {
  overview: "Источники кода",
  services: "Сервисы",
  browser: "Клиенты",
  lms: "LMS",
  database: "База данных",
  repository: "Репозиторий",
  logs: "Журнал",
  settings: "Настройки"
};

let isBusy = false;
let busyOperationCount = 0;
let launcherLogPath = "";
let lastStatuses = [];
let localServices = [];
let serviceCardsFingerprint = "";
let lmsLayoutScheduled = false;
let lastLmsLayout = "";
let lastLmsLayoutVisible = false;
let activeLogPath = "";
let activeLogLabel = "";
let logReadGeneration = 0;
let activeLogRead = null;
let renderedLogPath = "";
let renderedLogSnapshot = null;
let logSelectionPaused = false;
let activeBrowserMode = "deploy";
let lastLmsBrowserMode = "preview";
let isBrowserFocusMode = false;
let previewClients = [];
let activeView = "overview";
let activeDatabaseTable = "";
let databaseRequestVersion = 0;
let databaseReadBusy = false;
let databasePendingRead = null;
let databaseRowsFingerprint = "";
let databaseRowsTable = "";
let statusRefreshPromise = null;
let nativeWindowVisible = true;
let windowPollingVisible = !document.hidden;
const statusRefreshQueue = window.coreRefreshQueue.createRefreshQueue(async (fresh) => {
  const statuses = await launcherBridge.getStatuses({ fresh });
  renderStatuses(statuses);
});
let repositoryState = null;
let sourceLibraryController = null;
let repositoryBusy = false;
let clientSelectionPurpose = "preview";
let repositoryTargetRequest = 0;
let repositoryTargetClientId = "";
let installationAccessState = null;
let installationAccessClient = "";
let sourceState = null;
let sourceIsWorking = false;
let remoteBusy = false;
let deploymentWorkflow = null;
let aiConfigurationController = null;
let aiBaseContext = "";
let aiKnownInstallation = "";
let aiReceiptContext = "";
let mailConfigurationController = null;
let mailBaseContext = "";
let mailKnownInstallation = "";
let mailReceiptContext = "";
let newInstallationPlan = null;
let serverAccess = null;
let uninstallationState = null;
let uninstallationAccepted = false;
let newInstallationState = null;
let ipPublicationState = null;
let lmsViewerState = { phase: "closed" };
let gitPreviewState = { phase: "idle", message: "Запустите локальный просмотр выбранной Git-версии." };
let gitPreviewAction = false;
let gitPreviewOpening = false;
let gitPreviewError = "";
let pointInspector = null;
let serverPreparationState = null;
let executionMode = "local";
let newInstallationRequest = 0;
let installationCheckExpiryTimer = null;
let repositoryClientSlug = "";
const buttonDisabledBeforeBusy = new WeakMap();
const panelSelection = window.corePanelSelection.createPanelSelectionSession(() => crypto.randomUUID());
let panelContextTargetUrl = "";
let pendingPanelClientId = null;
let pendingPanelState = null;
let browserNavigationRevision = 0;
const clientChoice = window.coreClientChoice.createClientChoiceStore(
  () => window.localStorage,
  () => setDiagnostics("Выбор клиента хранится только в этом окне: локальное хранилище недоступно. Настройки приложения сохраняются отдельно в профиле Windows.")
);

function getStoredPreviewClientId() {
  return clientChoice.get("id");
}

function setStoredPreviewClientId(clientId, fromPanel = false) {
  const serverClientChanged = getStoredPreviewClientId() !== clientId;
  if (serverClientChanged) clearRemoteCredentials();
  if (!fromPanel && getStoredPreviewClientId() !== clientId) { panelSelection.invalidate(); panelContextTargetUrl = ""; }
  if (lmsViewerState.clientId && lmsViewerState.clientId !== clientId) {
    void Promise.resolve().then(() => launcherBridge?.closeLmsViewer?.()).catch(() => setDiagnostics("Не удалось закрыть предыдущий просмотр LMS. Закройте его перед подключением к другому клиенту."));
  }
  clientChoice.set("id", clientId);
  if (serverClientChanged && serverAccess) void serverAccess.load();
}

function getStoredPreviewClientName() {
  return clientChoice.get("name");
}

function setStoredPreviewClientName(clientName) {
  clientChoice.set("name", clientName);
}

function getPreferences() {
  try {
    return window.corePreferences.normalize(JSON.parse(localStorage.getItem("control-center.preferences") || "null"));
  } catch (_error) {
    return window.corePreferences.normalize(null);
  }
}

let currentPreferences = getPreferences();
let preferencesWriteQueue = Promise.resolve();
let preferenceRevision = 0;
let statusPollTimer;
let logPollTimer;
let pollingStarted = false;
let statusPollInterval = 0;
let logPollInterval = 0;
let deployAppearanceReady = false;

function getCurrentPreferences() {
  return { ...currentPreferences };
}

function settingsSaveStatus(message, error = false) {
  const status = document.getElementById("settings-save-status");
  status.textContent = message;
  status.dataset.tone = error ? "error" : "saved";
  document.getElementById("retry-settings-save").classList.toggle("hidden", !error);
}

function cachePreferences(preferences) {
  try { localStorage.setItem("control-center.preferences", JSON.stringify(preferences)); }
  catch { /* The canonical copy remains in the Windows profile if browser storage is unavailable. */ }
}

function syncDeployAppearance() {
  if (!deployAppearanceReady || !embeddedPanelFrame?.contentWindow || activeBrowserMode !== "deploy") return;
  try {
    const frameUrl = new URL(embeddedPanelFrame.src);
    const expected = new URL(buildBrowserUrl("deploy"));
    if (frameUrl.origin !== expected.origin) return;
    const { theme, density, textSize, reducedMotion, detailLevel, uiFont, borderContrast } = currentPreferences;
    embeddedPanelFrame.contentWindow.postMessage({ type: "lms-core:appearance", version: 1, theme, density, textSize, reducedMotion, detailLevel, uiFont, borderContrast }, expected.origin);
  } catch { /* No panel has been loaded yet. Its load/ready event will synchronize it. */ }
}

function preparePanelFrameContext(targetUrl) {
  if (!["deploy", "preview"].includes(activeBrowserMode)) { panelSelection.invalidate(); panelContextTargetUrl = ""; pendingPanelClientId = null; return; }
  pendingPanelClientId = getStoredPreviewClientId();
  panelContextTargetUrl = targetUrl;
  panelSelection.begin(pendingPanelClientId);
}

function syncPanelClientContext() {
  if (!["deploy", "preview"].includes(activeBrowserMode) || !embeddedPanelFrame?.contentWindow) return;
  try {
    const expected = new URL(buildBrowserUrl(activeBrowserMode));
    if (new URL(embeddedPanelFrame.src).origin !== expected.origin) return;
    if (!panelSelection.envelope()) { panelSelection.begin(getStoredPreviewClientId()); panelContextTargetUrl = buildBrowserUrl(activeBrowserMode); }
    embeddedPanelFrame.contentWindow.postMessage(panelSelection.envelope(), expected.origin);
  } catch { /* Only the configured local panel participates in client selection. */ }
}

function receivePanelClientSelection(event) {
  if (document.body.dataset.clientDeleting === "true") return;
  if (activeBrowserMode !== "deploy" || !embeddedPanelFrame?.contentWindow) return;
  let origin;
  try { origin = new URL(buildBrowserUrl("deploy")).origin; } catch { return; }
  const choice = panelSelection.accept(event, embeddedPanelFrame.contentWindow, origin);
  if (!choice) return;
  const changed = getStoredPreviewClientId() !== choice.id;
  if (changed && mailConfigurationController?.dirty()) { panelSelection.invalidate(); setDiagnostics("Выбор клиента не изменен: сначала сохраните или очистите почтовые параметры в Репозитории."); return; }
  if (changed && aiConfigurationController?.dirty()) { panelSelection.invalidate(); setDiagnostics("Выбор клиента не изменен: сначала сохраните или очистите ввод ИИ в Репозитории."); return; }
  setStoredPreviewClientId(choice.id, true);
  setStoredPreviewClientName(choice.name);
  browserClientIdInput.value = choice.id;
  const targetUrl = buildBrowserUrl("deploy");
  browserAddressInput.value = targetUrl;
  embeddedPanelFrame.dataset.targetUrl = targetUrl;
  panelContextTargetUrl = targetUrl;
  updatePreviewClientCaption();
  if (changed) {
    // Selection invalidates the former client's plan, never its server or any running installation.
    ++browserNavigationRevision;
    pendingPanelState?.finish(null);
    ++repositoryTargetRequest; ++newInstallationRequest;
    repositoryTargetClientId = ""; repositoryClientSlug = "";
    newInstallationPlan = null; newInstallationState = null; ipPublicationState = null; serverPreparationState = null; uninstallationState = null;
    renderNewInstallationPlan(); renderNewInstallationState();
    if (activeView === "repository") void loadRepositoryTarget();
  }
}

function showBrowserNavigationWarning(message) {
  const warning = document.getElementById("browser-navigation-warning");
  warning.textContent = message;
  warning.classList.toggle("hidden", !message);
  if (message) setDiagnostics(message);
}

async function canLeaveDeployPanel() {
  if (pointInspector?.hasUnsaved()) { showBrowserNavigationWarning("Сначала сохраните или отмените правки LMS в свойствах элемента."); return false; }
  if (activeBrowserMode !== "deploy" || !embeddedPanelFrame || embeddedPanelFrame.src === "about:blank") return true;
  try {
    let operation = pendingPanelState;
    if (!operation) {
      const context = panelSelection.envelope();
      if (!context) { showBrowserNavigationWarning("Панель еще не передала состояние формы. Повторите переход после ее загрузки."); return false; }
      const requestId = crypto.randomUUID();
      operation = { requestId, promise: null, finish: null };
      operation.promise = new Promise((resolve) => {
        const timer = setTimeout(() => operation.finish(null), 2500);
        operation.finish = (state) => { clearTimeout(timer); if (pendingPanelState === operation) pendingPanelState = null; resolve(state); };
      });
      pendingPanelState = operation;
      const origin = new URL(buildBrowserUrl(activeBrowserMode)).origin;
      embeddedPanelFrame.contentWindow.postMessage({ type: "lms-core:panel-state-request", version: 1, session: context.session, requestId }, origin);
    }
    const state = await operation.promise;
    if (!state || state.blocked) { showBrowserNavigationWarning("Не удалось проверить состояние формы. Переход отменен, чтобы не потерять введенные данные. Повторите после восстановления панели."); return false; }
    if (state.busy) { showBrowserNavigationWarning("В панели выполняется операция. Дождитесь ее завершения перед переходом."); return false; }
    if (state.dirty) { showBrowserNavigationWarning("Переход отменен: в панели есть несохраненные поля. Сохраните их или нажмите «Отменить правки» / «Очистить форму»."); return false; }
    showBrowserNavigationWarning("");
    return true;
  } catch {
    pendingPanelState?.finish(null);
    showBrowserNavigationWarning("Не удалось связаться с формой. Переход отменен; введенные данные не сброшены.");
    return false;
  }
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  document.documentElement.dataset.coreTheme = theme;
  document.documentElement.dataset.coreColorScheme = window.corePreferences.themes[theme].light ? "light" : "dark";

  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.classList.toggle("is-current", button.getAttribute("data-theme-choice") === theme);
    button.setAttribute("aria-pressed", String(button.getAttribute("data-theme-choice") === theme));
  });
  document.getElementById("active-theme-label").textContent = window.corePreferences.themes[theme].label;
}

function syncSettingsUi() {
  const preferences = getCurrentPreferences();

  applyTheme(preferences.theme);
  for (const key of ["density", "textSize", "sidebarWidth", "detailLevel", "reducedMotion", "uiFont", "contentWidth", "borderContrast", "showServiceSummary", "logWrap"]) document.body.dataset[key] = String(preferences[key]);
  document.documentElement.dataset.coreUiFont = preferences.uiFont;
  document.documentElement.dataset.coreBorderContrast = preferences.borderContrast;
  const fields = { "density-select": "density", "text-size-select": "textSize", "sidebar-width-select": "sidebarWidth", "detail-level-select": "detailLevel", "status-interval-select": "statusInterval", "ui-font-select": "uiFont", "content-width-select": "contentWidth", "border-contrast-select": "borderContrast", "log-line-limit-select": "logLineLimit", "log-interval-select": "logInterval" };
  for (const [id, key] of Object.entries(fields)) document.getElementById(id).value = String(preferences[key]);
  document.getElementById("reduced-motion-checkbox").checked = preferences.reducedMotion;
  document.getElementById("maximize-on-start-checkbox").checked = preferences.maximizeOnStart;
  document.getElementById("auto-refresh-logs-checkbox").checked = preferences.autoRefreshLogs;
  document.getElementById("show-service-summary-checkbox").checked = preferences.showServiceSummary;
  document.getElementById("keyboard-shortcuts-checkbox").checked = preferences.keyboardShortcuts;
  document.getElementById("log-wrap-checkbox").checked = preferences.logWrap;
  document.getElementById("status-refresh-caption").textContent = `Каждые ${preferences.statusInterval / 1000} с`;
  syncDeployAppearance();
  syncLmsViewerBounds();
  if (pollingStarted && (statusPollInterval !== preferences.statusInterval || logPollInterval !== preferences.logInterval)) configurePolling();

  if (defaultViewSelect) {
    defaultViewSelect.value = preferences.defaultView;
  }

  if (autoFocusPreviewCheckbox) {
    autoFocusPreviewCheckbox.checked = preferences.autoFocusPreview;
  }

  if (rememberLastViewCheckbox) {
    rememberLastViewCheckbox.checked = preferences.rememberLastView;
  }
}

function persistSettingsPatch(patch, force = false) {
  const nextPreferences = window.corePreferences.normalize({
    ...getCurrentPreferences(),
    ...patch
  });
  if (!force && JSON.stringify(nextPreferences) === JSON.stringify(currentPreferences)) return;
  currentPreferences = nextPreferences;
  cachePreferences(nextPreferences);
  syncSettingsUi();
  const revision = ++preferenceRevision;
  settingsSaveStatus("Сохраняю...");
  // Send each change immediately; Electron serializes disk writes and flushes them on normal exit.
  const saving = (async () => {
    try {
      if (launcherBridge?.saveInterfacePreferences) await launcherBridge.saveInterfacePreferences(nextPreferences);
      if (revision === preferenceRevision) settingsSaveStatus("Сохранено на этом компьютере");
    } catch {
      settingsSaveStatus("Не удалось сохранить в профиль Windows. Повторите изменение; настройки пока действуют в этом окне.", true);
    }
  })();
  preferencesWriteQueue = Promise.all([preferencesWriteQueue, saving]).then(() => undefined);
}

function getTariffLabel(tariff) {
  if (tariff === "base") {
    return "Базовый";
  }

  if (tariff === "extended") {
    return "Расширенный";
  }

  if (tariff === "corporate") {
    return "Корпоративный";
  }

  return tariff || "Не задан";
}

function localServiceOrigin(id, fallbackPort) {
  const service = localServices.find((item) => item.id === id) || lastStatuses.find((item) => item.id === id);
  const port = service?.port;
  return `http://127.0.0.1:${Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallbackPort}`;
}

function buildBrowserUrl(mode) {
  const clientId = (browserClientIdInput?.value || getStoredPreviewClientId()).trim();
  const deployOrigin = localServiceOrigin("deploy-panel", 3002);
  const previewOrigin = localServiceOrigin("lms-web", 3100);

  if (mode === "deploy") {
    return clientId
      ? `${deployOrigin}/?clientId=${encodeURIComponent(clientId)}`
      : `${deployOrigin}/`;
  }

  if (mode === "preview") {
    return "";
  }

  return `${previewOrigin}/`;
}

function setBusy(nextValue) {
  const wasBusy = isBusy;
  busyOperationCount = Math.max(0, busyOperationCount + (nextValue ? 1 : -1));
  isBusy = busyOperationCount > 0;

  if (wasBusy === isBusy) {
    return;
  }

  document.querySelectorAll("button").forEach((button) => {
    const allowedIds = new Set([
      "refresh-button",
      "open-config-button",
      "open-launcher-log-button",
      "open-log-view-launcher-button",
      "log-scroll-bottom",
      "reload-embedded-panel-button",
      "browser-tab-deploy",
      "browser-tab-preview",
      "choose-preview-client-button",
      "toggle-browser-focus-button"
    ]);

    if (allowedIds.has(button.id) || button.hasAttribute("data-view-target") || button.hasAttribute("data-settings-tab") || button.dataset.themeChoice || button.id === "reset-appearance-button" || button.id === "retry-settings-save" || button.closest("#view-repository")) {
      return;
    }

    if (isBusy) {
      rememberAndDisableButton(button);
    } else if (buttonDisabledBeforeBusy.has(button)) {
      button.disabled = buttonDisabledBeforeBusy.get(button);
      buttonDisabledBeforeBusy.delete(button);
    }
  });
}

function rememberAndDisableButton(button) {
  if (!buttonDisabledBeforeBusy.has(button)) {
    buttonDisabledBeforeBusy.set(button, button.disabled);
  }
  button.disabled = true;
}

function setDiagnostics(text) {
  diagnosticsText.textContent = text;
}

function setButtonPressed(button) {
  if (!button) {
    return;
  }

  button.classList.add("is-pressed");
  setTimeout(() => {
    button.classList.remove("is-pressed");
  }, 180);
}

function setButtonWorking(button, isWorking) {
  if (!button) {
    return;
  }

  button.classList.toggle("is-working", isWorking);
}

function setCardState(card, feedback, state, text) {
  card.classList.remove("is-active", "is-success", "is-error");
  feedback.classList.remove("state-working", "state-success", "state-error");

  if (state === "working") {
    card.classList.add("is-active");
    feedback.classList.add("state-working");
  }

  if (state === "success") {
    card.classList.add("is-success");
    feedback.classList.add("state-success");
  }

  if (state === "error") {
    card.classList.add("is-error");
    feedback.classList.add("state-error");
  }

  feedback.textContent = text;
}

function clearCardStateLater(card, feedback) {
  setTimeout(() => {
    card.classList.remove("is-active", "is-success", "is-error");
    feedback.classList.remove("state-working", "state-success", "state-error");
    feedback.textContent = "";
  }, 1800);
}

function buildMeta(status) {
  return [
    `Порт: ${status.port}`,
    status.pid ? `PID: ${status.pid}` : null,
    status.checkedAt ? `Проверено: ${new Date(status.checkedAt).toLocaleTimeString("ru-RU")}` : null,
    status.url ? `URL: ${status.url}` : null
  ].filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatBytes(value) {
  const numericValue = Number(value || 0);

  if (numericValue < 1024) {
    return `${numericValue} B`;
  }

  if (numericValue < 1024 * 1024) {
    return `${(numericValue / 1024).toFixed(1)} KB`;
  }

  return `${(numericValue / 1024 / 1024).toFixed(1)} MB`;
}

function formatCellValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function getServiceForBrowserMode(statuses, mode) {
  if (mode === "deploy") {
    return statuses.find((item) => item.id === "deploy-panel");
  }

  if (mode === "preview" || mode === "lms") {
    return statuses.find((item) => item.id === "lms-web");
  }

  return null;
}

function updateEmbeddedCaption(mode) {
  const caption = document.getElementById("embedded-panel-caption");
  const previewClientName = getStoredPreviewClientName();

  if (!caption) {
    return;
  }

  if (mode === "preview") {
    caption.textContent = previewClientName
      ? `Git-LMS клиента: ${previewClientName}`
      : "Локальный просмотр Git-LMS";
    return;
  }

  caption.textContent = "Создание клиентов, статусы деплоя и мониторинг";
}

function setBrowserFocusMode(nextValue) {
  isBrowserFocusMode = nextValue;
  document.body.classList.toggle("browser-focus-mode", nextValue);

  if (toggleBrowserFocusButton) {
    toggleBrowserFocusButton.textContent = nextValue ? "Обычный режим" : "Развернуть просмотр";
    toggleBrowserFocusButton.setAttribute("aria-pressed", String(nextValue));
  }
}

function setActiveView(viewName) {
  if (document.body.dataset.clientDeleting === "true") { setDiagnostics("Дождитесь результата удаления клиента."); return; }
  if (viewName === "browser" && mailConfigurationController?.dirty()) {
    deploymentWorkflow?.select("access"); document.getElementById("mail-configuration-panel").open = true;
    const message = "В почтовых параметрах есть несохраненный ввод. Сохраните его или нажмите «Очистить ввод» перед сменой клиента.";
    document.getElementById("remote-feedback").textContent = message; setDiagnostics(message); return;
  }
  if (viewName === "browser" && aiConfigurationController?.dirty()) {
    deploymentWorkflow?.select("access"); document.getElementById("ai-configuration-panel").open = true;
    const message = "В блоке ИИ есть несохраненный ввод. Сохраните его или нажмите «Очистить ввод» перед сменой клиента.";
    document.getElementById("remote-feedback").textContent = message; setDiagnostics(message); return;
  }
  if (viewName !== "lms" && pointInspector?.hasUnsaved()) { showBrowserNavigationWarning("Сначала сохраните или отмените правки LMS в свойствах элемента."); return; }
  if (!Object.hasOwn(viewLabels, viewName)) viewName = "overview";
  activeView = viewName;
  document.body.dataset.workspaceView = viewName;
  const workspaceId = viewName === "lms" ? "browser" : viewName;

  document.querySelectorAll(".workspace-view").forEach((view) => {
    view.classList.toggle("is-current", view.id === `view-${workspaceId}`);
  });

  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("is-current", button.getAttribute("data-view-target") === viewName);
    if (button.getAttribute("data-view-target") === viewName) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  if (statCurrentView) {
    statCurrentView.textContent = viewLabels[viewName] || viewName;
  }

  const workspaceTitle = document.getElementById("workspace-title");
  if (workspaceTitle) {
    workspaceTitle.textContent = viewLabels[viewName] || viewName;
  }

  if (getCurrentPreferences().rememberLastView) {
    persistSettingsPatch({ defaultView: viewName });
  }
  if (viewName === "repository") void loadRepositoryTarget();
  if (viewName === "logs") void refreshActiveLog().catch((error) => setDiagnostics(`Не удалось прочитать журнал: ${error instanceof Error ? error.message : String(error)}`));
  if (["browser", "lms"].includes(viewName)) syncBrowserFrame(lastStatuses);
  syncLmsViewerBounds();
}

function syncLmsViewerBounds() {
  if (!launcherBridge?.layoutLmsViewer || lmsLayoutScheduled) return;
  lmsLayoutScheduled = true;
  requestAnimationFrame(() => {
    lmsLayoutScheduled = false;
    const host = document.getElementById("native-lms-view-host");
    if (!host) return;
    const gitHost = document.getElementById("native-git-view-host");
    if (gitHost && launcherBridge.layoutGitPreview) {
      const rect = gitHost.getBoundingClientRect();
      void launcherBridge.layoutGitPreview({ visible: activeView === "lms" && activeBrowserMode === "preview" && gitPreviewState.phase === "ready" && gitPreviewState.clientId === getStoredPreviewClientId() && previewClientModal.classList.contains("hidden"), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }).catch(() => {});
    }
    const visible = activeView === "lms" && activeBrowserMode === "remote" && lmsViewerState.phase === "open" && previewClientModal.classList.contains("hidden");
    if (!visible && !lastLmsLayoutVisible) return;
    const rect = host.getBoundingClientRect();
    const bounds = { visible, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    const key = JSON.stringify(bounds);
    if (lastLmsLayout === key) return;
    lastLmsLayout = key; lastLmsLayoutVisible = visible;
    void launcherBridge.layoutLmsViewer(bounds).catch(() => { lastLmsLayout = ""; });
  });
}

function updatePreviewClientCaption() {
  const previewClientName = getStoredPreviewClientName();
  statPreviewClient.textContent = previewClientName || "Не выбран";
  const remove = document.getElementById("delete-client-button");
  if (remove) remove.disabled = !getStoredPreviewClientId() || !launcherBridge?.deleteClient || document.body.dataset.clientDeleting === "true";
}

function getServiceStatus(statuses, serviceId) {
  return statuses.find((item) => item.id === serviceId) || null;
}

function getHealthPresentation(status) {
  const state = status.state || status.healthState || (status.running ? "unknown" : "stopped");
  const labels = {
    healthy: "Отвечает",
    unhealthy: "Ошибка проверки",
    starting: "Запускается",
    stopping: "Останавливается",
    stopped: "Остановлен",
    unknown: "Не проверен"
  };
  const tone = state === "healthy" ? "running" : state === "unhealthy" ? "failed" :
    ["starting", "stopping", "unknown"].includes(state) ? "pending" : "stopped";
  return { state, label: labels[state] || labels.unknown, tone };
}

function getOverviewNextStep(statuses) {
  if (!statuses.length) {
    return {
      title: "Нет данных о сервисах",
      note: "Обнови статусы или проверь настройки локального контура."
    };
  }

  const postgres = getServiceStatus(statuses, "postgres");
  const api = getServiceStatus(statuses, "api");
  const lms = getServiceStatus(statuses, "lms-web");
  const deployPanel = getServiceStatus(statuses, "deploy-panel");

  const pending = statuses.find((status) => ["starting", "stopping"].includes(status.state));
  if (pending) {
    return { title: `${pending.label}: ${getHealthPresentation(pending).label.toLowerCase()}`, note: "Дождитесь результата операции. Подробности доступны в журнале." };
  }
  const failed = statuses.find((status) => status.healthState === "unhealthy");
  if (failed) {
    return { title: `Проверьте ${failed.label}`, note: failed.message || "Порт открыт, но проверка нужного сервиса не прошла." };
  }

  if (postgres && !postgres.running) {
    return {
      title: "Запусти PostgreSQL",
      note: "База нужна первой: без нее API, deploy-panel и просмотр клиентов будут работать нестабильно."
    };
  }

  if (api && !api.running) {
    return {
      title: "Запусти API ядра",
      note: "API связывает deploy-panel, клиентов, роли, health-check и данные PostgreSQL."
    };
  }

  if (deployPanel && !deployPanel.running) {
    return {
      title: "Запусти deploy-panel",
      note: "После запуска можно создавать клиентов, проверять профиль деплоя и открывать редактор LMS."
    };
  }

  if (lms && !lms.running) {
    return {
      title: "Запусти LMS Runtime",
      note: "LMS Runtime нужен для живого просмотра сайта клиента и проверки тарифов/цветов."
    };
  }

  return {
    title: statuses.every((status) => status.healthState === "healthy") ? "Локальные сервисы отвечают" : "Проверка не завершена",
    note: "Проверки подтверждают ответ приложений и запрос к проектной БД, но не заменяют проверку клиентского сценария."
  };
}

function updateOverview(statuses) {
  const runningCount = statuses.filter((item) => item.healthState === "healthy" && !["starting", "stopping"].includes(item.state)).length;
  const nextStep = getOverviewNextStep(statuses);

  summaryText.textContent = `Исправны: ${runningCount} из ${statuses.length}`;
  statServicesOnline.textContent = `${runningCount}/${statuses.length}`;
  const primaryAction = document.getElementById("start-all-button");
  if (primaryAction && !isBusy) {
    primaryAction.disabled = !statuses.length;
    primaryAction.textContent = statuses.length && runningCount === statuses.length ? "Открыть панель клиентов" : "Запустить ядро";
  }
  updatePreviewClientCaption();

  if (overviewNextStep) {
    overviewNextStep.textContent = nextStep.title;
  }

  if (overviewNextStepNote) {
    overviewNextStepNote.textContent = nextStep.note;
  }

  if (overviewServiceStrip) {
    const markup = statuses
      .map((status) => {
        const health = getHealthPresentation(status);

        return `
          <article class="service-pill is-${health.tone}">
            <strong>${escapeHtml(serviceDisplayName(status))}</strong>
            <span>${health.label} • ${escapeHtml(status.port)}</span>
            ${status.healthState === "unhealthy" ? `<small class="service-problem">${escapeHtml(status.message || "Проверьте журнал сервиса.")}</small>` : ""}
          </article>
        `;
      })
      .join("");
    if (overviewServiceStrip.innerHTML !== markup) overviewServiceStrip.innerHTML = markup;
  }

  if (overviewOperatorChecklist) {
    overviewOperatorChecklist.innerHTML = statuses
      .map((status) => {
        const marker = status.running ? "OK" : "Нужно";
        const note = status.running ? "готов к работе" : "запусти в разделе «Сервисы»";

        return `
          <article class="overview-check-item ${status.running ? "is-running" : "is-stopped"}">
            <span>${marker}</span>
            <strong>${escapeHtml(status.label)}</strong>
            <small>${note}</small>
          </article>
        `;
      })
      .join("");
  }
}

async function setBrowserMode(mode, customUrl, panelChecked = false) {
  if (mode === "deploy" && mailConfigurationController?.dirty()) {
    setActiveView("repository"); deploymentWorkflow?.select("access"); document.getElementById("mail-configuration-panel").open = true;
    document.getElementById("remote-feedback").textContent = "Сначала сохраните почтовые параметры на сервере или очистите несохраненный ввод этого блока. Выбор клиента не менялся.";
    return false;
  }
  if (mode === "deploy" && aiConfigurationController?.dirty()) {
    setActiveView("repository"); deploymentWorkflow?.select("access"); document.getElementById("ai-configuration-panel").open = true;
    document.getElementById("remote-feedback").textContent = "Сначала сохраните ИИ на сервере или очистите несохраненный ввод этого блока. Выбор клиента не менялся.";
    return false;
  }
  if (mode !== "preview" && pointInspector?.hasUnsaved()) { showBrowserNavigationWarning("Сначала сохраните или отмените правки LMS в свойствах элемента."); return false; }
  const navigation = ++browserNavigationRevision;
  const nextUrl = customUrl ?? buildBrowserUrl(mode);
  const leavingPanel = activeBrowserMode === "deploy" && (mode !== activeBrowserMode || embeddedPanelFrame?.dataset.targetUrl !== nextUrl);
  if (leavingPanel && !panelChecked && !await canLeaveDeployPanel()) return false;
  if (navigation !== browserNavigationRevision) return false;
  activeBrowserMode = mode;
  if (["preview", "remote"].includes(mode)) lastLmsBrowserMode = mode;
  if (mode !== "deploy") { panelSelection.invalidate(); panelContextTargetUrl = ""; pendingPanelClientId = null; }

  browserTabDeploy?.classList.toggle("is-current", mode === "deploy");
  browserTabPreview?.classList.toggle("is-current", mode === "preview");
  document.getElementById("browser-tab-remote").classList.toggle("is-current", mode === "remote");

  if (browserAddressInput) {
    browserAddressInput.value = nextUrl;
  }

  updateEmbeddedCaption(mode);
  setActiveView(mode === "deploy" ? "browser" : "lms");
  syncBrowserFrame(lastStatuses);
  return true;
}

async function fetchPreviewClients() {
  const response = await launcherBridge.fetchJson("http://127.0.0.1:3001/api/deploy-panel/dashboard");
  return Array.isArray(response?.clients) ? response.clients : [];
}

function renderPreviewClientList(filterText = "") {
  const normalizedFilter = filterText.trim().toLowerCase();
  const items = normalizedFilter
    ? previewClients.filter((client) => {
        const haystack = [client.name, client.brandName, client.domain].join(" ").toLowerCase();
        return haystack.includes(normalizedFilter);
      })
    : previewClients;

  if (items.length === 0) {
    previewClientList.innerHTML = '<div class="modal-client-meta">Клиенты не найдены.</div>';
    return;
  }

  previewClientList.innerHTML = items
    .map(
      (client) => `
        <button class="modal-client-button" data-client-id="${escapeHtml(client.id)}" data-client-name="${escapeHtml(client.name)}">
          <span class="modal-client-name">${escapeHtml(client.name)}</span>
          <span class="modal-client-meta">
            ${escapeHtml(client.brandName)} • ${escapeHtml(client.domain)}<br />
            Тариф: ${escapeHtml(getTariffLabel(client.tariff))} • Статус: ${escapeHtml(client.deployStatusLabel)}
          </span>
        </button>
      `
    )
    .join("");

  previewClientList.querySelectorAll(".modal-client-button").forEach((button) => {
    button.addEventListener("click", () => {
      applyPreviewClient(button.getAttribute("data-client-id") || "", button.getAttribute("data-client-name") || "");
    });
  });
}

function openPreviewClientModal() {
  previewClientModal?.classList.remove("hidden");
  previewClientSearchInput?.focus();
}

function closePreviewClientModal() {
  previewClientModal?.classList.add("hidden");
}

async function applyPreviewClient(clientId, clientName) {
  if (clientId !== getStoredPreviewClientId() && mailConfigurationController?.dirty()) { previewClientModalCaption.textContent = "Сначала сохраните или очистите почтовые параметры текущего клиента в Репозитории."; return; }
  if (clientId !== getStoredPreviewClientId() && aiConfigurationController?.dirty()) { previewClientModalCaption.textContent = "Сначала сохраните или очистите несохраненный ввод ИИ текущего клиента в Репозитории."; return; }
  if (clientId !== getStoredPreviewClientId() && pointInspector?.hasUnsaved()) { previewClientModalCaption.textContent = "Сначала сохраните или отмените правки LMS текущего клиента."; return; }
  if (!clientId) {
    return;
  }
  const navigation = ++browserNavigationRevision;
  if (activeBrowserMode === "deploy" && (clientId !== getStoredPreviewClientId() || clientSelectionPurpose !== "repository") && !await canLeaveDeployPanel()) {
    previewClientModalCaption.textContent = "Сначала сохраните или очистите несохраненные поля текущей панели. Выбор клиента не изменен.";
    return;
  }
  if (navigation !== browserNavigationRevision) return;

  if (browserClientIdInput) {
    browserClientIdInput.value = clientId;
  }

  setStoredPreviewClientId(clientId);
  setStoredPreviewClientName(clientName);
  updatePreviewClientCaption();
  closePreviewClientModal();
  if (clientSelectionPurpose === "repository") {
    setActiveView("repository");
    return;
  }
  await setBrowserMode("preview", undefined, true);

  if (getCurrentPreferences().autoFocusPreview) {
    setBrowserFocusMode(true);
  }
}

async function choosePreviewClient(purpose = "preview") {
  if (!launcherBridge) {
    return;
  }

  clientSelectionPurpose = purpose;
  document.getElementById("preview-client-modal-title").textContent = purpose === "repository" ?
    "Получатель: выберите клиента" : "Выбор клиента для превью";
  previewClientModalCaption.textContent = "Загружаю список клиентов...";
  previewClientList.innerHTML = '<div class="modal-client-meta">Подожди, получаю клиентов...</div>';
  openPreviewClientModal();

  try {
    previewClients = await fetchPreviewClients();
    previewClientModalCaption.textContent = `Найдено клиентов: ${previewClients.length}`;
    renderPreviewClientList(previewClientSearchInput?.value || "");
  } catch (error) {
    previewClientModalCaption.textContent = "Не удалось загрузить клиентов.";
    previewClientList.innerHTML = `<div class="modal-client-meta">Ошибка: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
    setDiagnostics(`Не удалось загрузить список клиентов для preview: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function syncBrowserFrame(statuses) {
  const remote = activeBrowserMode === "remote";
  const git = activeBrowserMode === "preview";
  document.getElementById("git-preview-controls").classList.toggle("hidden", !git);
  document.getElementById("native-git-view-host").classList.toggle("hidden", !git || gitPreviewState.phase !== "ready" || gitPreviewState.clientId !== getStoredPreviewClientId());
  document.getElementById("point-workspace").classList.toggle("hidden", !git || gitPreviewState.clientId !== getStoredPreviewClientId() || gitPreviewState.phase !== "ready" && !pointInspector?.hasUnsaved());
  document.getElementById("native-lms-view-host").classList.toggle("hidden", !remote);
  document.getElementById("lms-viewer-caption").classList.toggle("hidden", !remote);
  document.getElementById("close-lms-viewer").classList.toggle("hidden", !remote);
  if (git) { embeddedPanelFrame.classList.add("hidden"); embeddedPanelOffline.classList.add("hidden"); renderGitPreview(); syncLmsViewerBounds(); return; }
  if (remote) { embeddedPanelFrame.classList.add("hidden"); embeddedPanelOffline.classList.add("hidden"); syncLmsViewerBounds(); return; }
  syncLmsViewerBounds();
  // Do not create a hidden Next renderer until the operator actually opens this section.
  // Once loaded, retain it across ordinary section changes so form drafts survive.
  if (!["browser", "lms"].includes(activeView) && !embeddedPanelFrame?.dataset.targetUrl) return;
  const service = getServiceForBrowserMode(statuses, activeBrowserMode);
  const targetUrl = activeBrowserMode === "custom" ? (browserAddressInput?.value?.trim() || buildBrowserUrl(activeBrowserMode)) : buildBrowserUrl(activeBrowserMode);

  if (activeBrowserMode === "custom") {
    embeddedPanelOffline?.classList.add("hidden");
    embeddedPanelFrame?.classList.remove("hidden");

    if (embeddedPanelFrame && embeddedPanelFrame.dataset.targetUrl !== targetUrl) {
      embeddedPanelFrame.dataset.targetUrl = targetUrl;
      deployAppearanceReady = false;
      embeddedPanelFrame.src = targetUrl;
    }

    return;
  }

  if (service?.healthState === "healthy") {
    embeddedPanelOffline?.classList.add("hidden");
    embeddedPanelFrame?.classList.remove("hidden");

    if (embeddedPanelFrame) {
      const currentTargetUrl = embeddedPanelFrame.dataset.targetUrl || "";
      const needsFreshLoad = currentTargetUrl !== targetUrl || embeddedPanelFrame.src === "about:blank";

      if (needsFreshLoad) {
        preparePanelFrameContext(targetUrl);
        embeddedPanelFrame.dataset.targetUrl = targetUrl;
        deployAppearanceReady = false;
        embeddedPanelFrame.src = targetUrl;
      }
      if (["deploy", "preview"].includes(activeBrowserMode) && (!panelSelection.envelope() || panelContextTargetUrl !== targetUrl)) {
        preparePanelFrameContext(targetUrl); pendingPanelClientId = null;
        syncPanelClientContext();
      }
    }

    return;
  }

  embeddedPanelFrame?.classList.add("hidden");
  embeddedPanelOffline?.classList.remove("hidden");

  const retainedDocument = embeddedPanelFrame?.dataset.targetUrl === targetUrl && embeddedPanelFrame.src !== "about:blank";
  if (embeddedPanelFrame && !retainedDocument) {
    embeddedPanelFrame.dataset.targetUrl = "";
    panelSelection.invalidate(); panelContextTargetUrl = ""; pendingPanelClientId = null;
    deployAppearanceReady = false;
    embeddedPanelFrame.src = "about:blank";
  }

  if (embeddedPanelOfflineTitle) {
    embeddedPanelOfflineTitle.textContent =
      service?.running ? "Сервис пока не подтвердил готовность" : activeBrowserMode === "deploy" ? "Панель клиентов сейчас не запущена" : "Редактор LMS сейчас не запущен";
  }

  if (embeddedPanelOfflineText) {
    embeddedPanelOfflineText.textContent =
      service?.running ? (service.message || "Порт занят, но нужное приложение не подтвердило готовность. Чужая страница не открывается.") : activeBrowserMode === "deploy"
        ? "Запусти панель деплоя, и встроенный просмотр появится здесь."
        : "Запусти LMS runtime, и здесь откроется preview-редактор выбранного клиента.";
    if (retainedDocument) embeddedPanelOfflineText.textContent += " Окно не перезагружено: несохраненные поля остаются в нем до восстановления связи.";
  }

  if (startEmbeddedPanelButton) {
    startEmbeddedPanelButton.textContent =
      service?.running ? "Повторить проверку" : activeBrowserMode === "deploy" ? "Запустить панель клиентов" : "Запустить редактор LMS";
  }
}

function hasLogSelection() {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && logPanelContent.contains(selection.anchorNode) && logPanelContent.contains(selection.focusNode));
}

function setLogUpdateStatus(message, tone = "normal") {
  const status = document.getElementById("log-update-status");
  status.textContent = message;
  status.dataset.tone = tone;
}

function selectLogPath(filePath, label) {
  if (activeLogPath !== filePath) {
    logReadGeneration++;
    renderedLogPath = "";
    logPanelContent.textContent = "Загрузка журнала...";
  }
  activeLogPath = filePath;
  activeLogLabel = label;
  logPanelCaption.textContent = label;
  logSelectionPaused = false;
}

function applyLogContent(content, filePath) {
  const limit = getCurrentPreferences().logLineLimit;
  // An unchanged log needs only its timestamp, not another text scan and scroll/layout pass.
  if (renderedLogPath === filePath && renderedLogSnapshot?.content === content && renderedLogSnapshot.limit === limit) return;
  const next = window.coreWorkspaceTools.logTail(content, limit) || "Файл журнала пока пуст.";
  const previous = logPanelContent.textContent;
  const newFile = renderedLogPath !== filePath;
  const follow = newFile || logPanelContent.scrollHeight - logPanelContent.clientHeight - logPanelContent.scrollTop <= 32;
  const scrollTop = logPanelContent.scrollTop;
  const scrollLeft = logPanelContent.scrollLeft;
  if (previous !== next) {
    const node = logPanelContent.firstChild;
    if (!newFile && node?.nodeType === Node.TEXT_NODE && logPanelContent.childNodes.length === 1 && next.startsWith(previous)) node.appendData(next.slice(previous.length));
    else logPanelContent.textContent = next;
  }
  renderedLogPath = filePath;
  renderedLogSnapshot = { content, limit };
  logPanelContent.scrollTop = follow ? logPanelContent.scrollHeight : scrollTop;
  logPanelContent.scrollLeft = newFile ? 0 : scrollLeft;
}

function refreshActiveLog({ force = false } = {}) {
  if (!activeLogPath || !launcherBridge || activeView !== "logs") return Promise.resolve();
  if (!force && hasLogSelection()) {
    logSelectionPaused = true;
    setLogUpdateStatus("Пауза: выделен текст", "paused");
    return Promise.resolve();
  }
  if (activeLogRead) {
    if (activeLogRead.path === activeLogPath && activeLogRead.generation === logReadGeneration) {
      activeLogRead.force ||= force;
      if (force && !activeLogRead.fresh) {
        if (!activeLogRead.started) {
          activeLogRead.fresh = true;
          return activeLogRead.promise;
        }
        // A manual refresh must still bypass the disk cache when an ordinary poll is already in flight.
        return activeLogRead.promise.catch(() => undefined).then(() => refreshActiveLog({ force: true }));
      }
      return activeLogRead.promise;
    }
    return activeLogRead.promise.catch(() => undefined).then(() => refreshActiveLog({ force }));
  }
  const read = { path: activeLogPath, generation: logReadGeneration, force, fresh: force, started: false, promise: null };
  setLogUpdateStatus("Чтение журнала...");
  read.promise = (async () => {
    try {
      const content = await Promise.resolve().then(() => {
        read.started = true;
        return launcherBridge.readLog(read.path, { fresh: read.fresh });
      });
      if (read.path !== activeLogPath || read.generation !== logReadGeneration || activeView !== "logs") return;
      if (!read.force && hasLogSelection()) {
        logSelectionPaused = true;
        setLogUpdateStatus("Пауза: выделен текст", "paused");
        return;
      }
      applyLogContent(content, read.path);
      logPanelCaption.textContent = activeLogLabel;
      logSelectionPaused = false;
      setLogUpdateStatus(`Обновлено ${new Date().toLocaleTimeString("ru-RU")}${getCurrentPreferences().autoRefreshLogs ? "" : " · автообновление выключено"}`);
    } catch (error) {
      if (read.path !== activeLogPath || read.generation !== logReadGeneration) return;
      setLogUpdateStatus("Не удалось прочитать журнал", "error");
      if (renderedLogPath !== read.path) logPanelContent.textContent = "Журнал недоступен. Проверьте файл или выберите другой журнал.";
      throw error;
    } finally { if (activeLogRead === read) activeLogRead = null; }
  })();
  activeLogRead = read;
  return read.promise;
}

async function showLog(filePath, label) {
  if (!filePath) {
    logReadGeneration++;
    activeLogPath = "";
    activeLogLabel = "";
    renderedLogPath = "";
    logPanelCaption.textContent = "Лог не задан";
    logPanelContent.textContent = "Для этого сервиса лог-файл не задан.";
    setLogUpdateStatus("Журнал не выбран");
    return;
  }

  selectLogPath(filePath, label);
  setActiveView("logs");
  try { await refreshActiveLog({ force: true }); }
  catch (error) { setDiagnostics(`Не удалось прочитать журнал: ${error instanceof Error ? error.message : String(error)}`); }
}

function renderDatabaseSnapshot(snapshot) {
  const tables = Array.isArray(snapshot?.tables) ? snapshot.tables : [];
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const selectedTable = snapshot?.selectedTable || tables[0]?.name || "";
  const selectedTableSummary = tables.find((table) => table.name === selectedTable);

  activeDatabaseTable = selectedTable;

  if (databaseCaption) {
    databaseCaption.textContent = `База: ${snapshot?.database || "lms_core"} • таблиц: ${tables.length}`;
  }

  if (databaseTableList) {
    const existing = new Map([...databaseTableList.querySelectorAll(".database-table-button")].map((button) => [button.dataset.tableName, button]));
    if (!tables.length) databaseTableList.innerHTML = '<div class="database-empty">Таблицы не найдены.</div>';
    else {
      databaseTableList.querySelectorAll(".database-empty").forEach((element) => element.remove());
      const retained = new Set();
      tables.forEach((table, index) => {
        let button = existing.get(table.name);
        if (!button) {
          button = document.createElement("button");
          button.className = "database-table-button";
          button.dataset.tableName = table.name;
          button.append(document.createElement("span"), document.createElement("small"));
          button.addEventListener("click", () => void loadPostgresSnapshot(button.dataset.tableName));
        }
        const caption = `${table.rows ?? 0} строк • ${formatBytes(table.totalBytes)}`;
        button.title = table.name;
        if (button.firstElementChild.textContent !== table.name) button.firstElementChild.textContent = table.name;
        if (button.lastElementChild.textContent !== caption) button.lastElementChild.textContent = caption;
        button.classList.toggle("is-current", table.name === selectedTable);
        button.setAttribute("aria-pressed", String(table.name === selectedTable));
        const position = databaseTableList.children[index];
        if (position !== button) databaseTableList.insertBefore(button, position || null);
        retained.add(table.name);
      });
      existing.forEach((button, name) => { if (!retained.has(name)) button.remove(); });
    }
  }

  if (databaseSelectedTable) {
    databaseSelectedTable.textContent = selectedTable || "Таблица не выбрана";
  }

  if (databaseSelectedTableMeta) {
    const totalRows = selectedTableSummary?.rows ?? rows.length;
    databaseSelectedTableMeta.textContent = totalRows
      ? `Всего строк: ${totalRows} • показано до 50`
      : "В таблице нет строк для предпросмотра.";
  }

  if (!databasePreviewTable) {
    return;
  }

  databasePreviewTable.classList.remove("is-loading", "is-changing-table");
  databasePreviewTable.setAttribute("aria-busy", "false");
  const fingerprint = JSON.stringify([selectedTable, rows]);
  databaseRowsTable = selectedTable;
  if (databaseRowsFingerprint === fingerprint) return;
  databaseRowsFingerprint = fingerprint;

  if (!rows.length) {
    databasePreviewTable.innerHTML = '<tbody><tr><td class="database-empty-cell">Нет данных для отображения.</td></tr></tbody>';
    return;
  }

  const columns = Object.keys(rows[0] || {});

  databasePreviewTable.innerHTML = `
    <thead>
      <tr>
        ${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (row) => `
            <tr>
              ${columns.map((column) => `<td>${escapeHtml(formatCellValue(row[column]))}</td>`).join("")}
            </tr>
          `
        )
        .join("")}
    </tbody>
  `;
}

function loadPostgresSnapshot(tableName = activeDatabaseTable) {
  if (!launcherBridge) return Promise.resolve();

  setActiveView("database");
  setDiagnostics("Загружаю PostgreSQL...");

  const hasRenderedTables = Boolean(databaseTableList?.querySelector(".database-table-button"));

  if (databaseTableList && !hasRenderedTables) {
    databaseTableList.innerHTML = '<div class="database-empty">Загрузка таблиц...</div>';
  }

  if (databaseTableList && tableName) {
    activeDatabaseTable = tableName;
    databaseTableList.querySelectorAll(".database-table-button").forEach((button) => {
      button.classList.toggle("is-current", button.getAttribute("data-table-name") === tableName);
      button.setAttribute("aria-pressed", String(button.getAttribute("data-table-name") === tableName));
    });
  }

  if (databaseSelectedTable) {
    databaseSelectedTable.textContent = tableName || activeDatabaseTable || "Загрузка...";
  }

  if (databaseSelectedTableMeta) {
    databaseSelectedTableMeta.textContent = "Загружаю строки...";
  }

  databasePreviewTable?.classList.add("is-loading");
  databasePreviewTable?.classList.toggle("is-changing-table", Boolean(tableName) && databaseRowsTable !== tableName);
  databasePreviewTable?.setAttribute("aria-busy", "true");

  return new Promise((resolve) => {
    // Keep only the latest queued selection; a rapid click cannot spawn dozens of SQL processes.
    databasePendingRead?.resolve();
    databasePendingRead = { version: ++databaseRequestVersion, tableName, resolve };
    if (!databaseReadBusy) void drainDatabaseReads();
  });
}

async function drainDatabaseReads() {
  databaseReadBusy = true;
  try {
    while (databasePendingRead) {
      const request = databasePendingRead;
      databasePendingRead = null;
      try {
        const snapshot = await launcherBridge.getPostgresSnapshot(request.tableName || undefined);
        if (request.version !== databaseRequestVersion) continue;
        renderDatabaseSnapshot(snapshot);
        setDiagnostics("PostgreSQL загружен во встроенный просмотр.");
      } catch (error) {
        if (request.version !== databaseRequestVersion) continue;
        const message = error instanceof Error ? error.message : String(error);
        setDiagnostics(`Ошибка PostgreSQL: ${message}`);
        if (databaseSelectedTableMeta) databaseSelectedTableMeta.textContent = "Ошибка чтения. Обновите данные или выберите другую таблицу.";
        if (databaseTableList && !databaseTableList.querySelector(".database-table-button")) databaseTableList.innerHTML = `<div class="database-empty">Ошибка: ${escapeHtml(message)}</div>`;
        if (databasePreviewTable) {
          databaseRowsFingerprint = "";
          databaseRowsTable = "";
          databasePreviewTable.classList.remove("is-loading", "is-changing-table");
          databasePreviewTable.setAttribute("aria-busy", "false");
          databasePreviewTable.innerHTML = '<tbody><tr><td class="database-empty-cell">Не удалось загрузить строки. Повторите обновление.</td></tr></tbody>';
        }
      } finally { request.resolve(); }
    }
  } finally { databaseReadBusy = false; }
}

function serviceDisplayName(status) {
  return ({ postgres: "PostgreSQL", api: "API ядра", "lms-web": "Служба оформления", "deploy-panel": "Панель клиентов" })[status.id] || status.label;
}

function renderStatuses(statuses) {
  lastStatuses = statuses;
  updateOverview(statuses);
  syncBrowserFrame(statuses);
  const fingerprint = JSON.stringify(statuses.map(({ checkedAt, responseTimeMs, ...stable }) => stable));
  if (fingerprint === serviceCardsFingerprint && servicesGrid.children.length === statuses.length) {
    statuses.forEach((status, index) => {
      const meta = servicesGrid.children[index].querySelector(".service-meta");
      const markup = buildMeta(status).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
      if (meta.innerHTML !== markup) meta.innerHTML = markup;
    });
    return;
  }
  serviceCardsFingerprint = fingerprint;
  servicesGrid.innerHTML = "";

  statuses.forEach((status) => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector(".service-card");
    const title = fragment.querySelector(".service-title");
    const kind = fragment.querySelector(".service-kind");
    const badge = fragment.querySelector(".service-badge");
    const feedback = fragment.querySelector(".service-feedback");
    const meta = fragment.querySelector(".service-meta");
    const message = fragment.querySelector(".service-message");
    const startButton = fragment.querySelector(".start-button");
    const stopButton = fragment.querySelector(".stop-button");
    const openUrlButton = fragment.querySelector(".open-url-button");
    const showAppButton = fragment.querySelector(".show-app-button");
    const openLogButton = fragment.querySelector(".open-log-button");
    const showLogButton = fragment.querySelector(".show-log-button");
    card.dataset.healthState = status.healthState || "unknown";
    showAppButton.textContent = ({ postgres: "Таблицы", "deploy-panel": "Клиенты", "lms-web": "LMS из Git", api: "Ответ API" })[status.id] || "В приложении";

    title.textContent = serviceDisplayName(status);
    kind.textContent = status.kind === "postgres" ? "Проектная база данных" : "Локальный сервис";
    kind.title = status.logFile || "Журнал пока не задан";
    const health = getHealthPresentation(status);
    badge.textContent = health.label;
    badge.classList.add(health.tone);
    meta.innerHTML = buildMeta(status)
      .map((item) => `<span>${escapeHtml(item)}</span>`)
      .join("");
    message.textContent = status.message || "Результат проверки пока неизвестен.";

    if (status.id === "postgres") {
      openUrlButton.textContent = "pgAdmin";
      showAppButton.disabled = false;
    }

    startButton.addEventListener("click", async () => {
      setButtonPressed(startButton);
      setCardState(card, feedback, "working", "Запуск...");
      setButtonWorking(startButton, true);

      try {
        setBusy(true);
        setDiagnostics(`Запускаю ${status.label}...`);
        const result = await launcherBridge.startService(status.id);
        await refreshStatuses({ fresh: true });
        if (result.ok === false || !result.running) {
          throw new Error(result.message || "Порт сервиса не открылся.");
        }
        setDiagnostics(`${status.label}: запуск выполнен.`);
        setCardState(card, feedback, "success", "Запуск выполнен");
      } catch (error) {
        setDiagnostics(`Ошибка запуска ${status.label}: ${error instanceof Error ? error.message : String(error)}`);
        setCardState(card, feedback, "error", "Ошибка запуска");
      } finally {
        setButtonWorking(startButton, false);
        setBusy(false);
        clearCardStateLater(card, feedback);
      }
    });

    stopButton.addEventListener("click", async () => {
      setButtonPressed(stopButton);
      setCardState(card, feedback, "working", "Остановка...");
      setButtonWorking(stopButton, true);

      try {
        setBusy(true);
        setDiagnostics(`Останавливаю ${status.label}...`);
        const result = await launcherBridge.stopService(status.id);
        await refreshStatuses({ fresh: true });
        if (result.ok === false || result.running) {
          throw new Error(result.message || "Порт сервиса остался открытым.");
        }
        setDiagnostics(`${status.label}: остановка выполнена.`);
        setCardState(card, feedback, "success", "Остановка выполнена");
      } catch (error) {
        setDiagnostics(`Ошибка остановки ${status.label}: ${error instanceof Error ? error.message : String(error)}`);
        setCardState(card, feedback, "error", "Ошибка остановки");
      } finally {
        setButtonWorking(stopButton, false);
        setBusy(false);
        clearCardStateLater(card, feedback);
      }
    });

    openUrlButton.disabled = !status.url && status.id !== "postgres";
    openUrlButton.classList.toggle("hidden", status.id === "lms-web");
    openUrlButton.addEventListener("click", async () => {
      setButtonPressed(openUrlButton);

      if (status.id === "postgres") {
        await launcherBridge.openPgAdmin();
        setCardState(card, feedback, "success", "pgAdmin открыт");
        clearCardStateLater(card, feedback);
        return;
      }

      if (!status.url) {
        return;
      }

      await launcherBridge.openUrl(status.url);
      setCardState(card, feedback, "success", "Открыто отдельно");
      clearCardStateLater(card, feedback);
    });

    showAppButton.disabled = !status.url && status.id !== "postgres";
    showAppButton.addEventListener("click", () => {
      setButtonPressed(showAppButton);

      if (status.id === "postgres") {
        void loadPostgresSnapshot();
      } else if (status.id === "deploy-panel") {
        setBrowserMode("deploy");
      } else if (status.id === "lms-web") {
        setBrowserMode("preview");
      } else if (status.url) {
        setBrowserMode("custom", status.url);
      }

      setCardState(card, feedback, "success", "Показано внутри app");
      clearCardStateLater(card, feedback);
    });

    openLogButton.disabled = !status.logFile;
    openLogButton.addEventListener("click", async () => {
      setButtonPressed(openLogButton);

      if (!status.logFile) {
        return;
      }

      await launcherBridge.openFile(status.logFile);
      setCardState(card, feedback, "success", "Лог открыт");
      clearCardStateLater(card, feedback);
    });

    showLogButton.disabled = !status.logFile;
    showLogButton.addEventListener("click", async () => {
      setButtonPressed(showLogButton);
      await showLog(status.logFile, `${status.label} • ${status.logFile}`);
      setCardState(card, feedback, "success", "Лог загружен");
      clearCardStateLater(card, feedback);
    });

    servicesGrid.appendChild(fragment);
  });

  if (isBusy) {
    servicesGrid.querySelectorAll("button").forEach(rememberAndDisableButton);
  }
}

async function refreshStatuses({ fresh = false } = {}) {
  const pending = statusRefreshQueue.request(fresh);
  statusRefreshPromise = pending;
  try {
    await pending;
  } finally {
    if (statusRefreshPromise === pending) {
      statusRefreshPromise = null;
    }
  }
}

function bindNavigation() {
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => {
      setButtonPressed(button);
      const view = button.getAttribute("data-view-target") || "overview";
      if (view === "browser") { void setBrowserMode("deploy"); return; }
      if (view === "lms") { void setBrowserMode(lastLmsBrowserMode === "remote" && lmsViewerState.phase === "open" ? "remote" : "preview"); return; }
      if (view === "database") {
        void loadPostgresSnapshot();
        return;
      }

      setActiveView(view);
    });
  });
}

function bindSettings() {
  document.getElementById("retry-settings-save").addEventListener("click", () => persistSettingsPatch({}, true));
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.settingsTab;
      document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
        tab.classList.toggle("is-current", tab.dataset.settingsTab === target);
        tab.setAttribute("aria-pressed", String(tab.dataset.settingsTab === target));
      });
      document.querySelectorAll("[data-settings-group]").forEach((group) => group.classList.toggle("hidden", group.dataset.settingsGroup !== target));
    });
  });
  const selectFields = { "density-select": "density", "text-size-select": "textSize", "sidebar-width-select": "sidebarWidth", "detail-level-select": "detailLevel", "status-interval-select": "statusInterval", "ui-font-select": "uiFont", "content-width-select": "contentWidth", "border-contrast-select": "borderContrast", "log-line-limit-select": "logLineLimit", "log-interval-select": "logInterval" };
  for (const [id, key] of Object.entries(selectFields)) {
    document.getElementById(id).addEventListener("change", (event) => persistSettingsPatch({ [key]: ["statusInterval", "logInterval", "logLineLimit"].includes(key) ? Number(event.target.value) : event.target.value }));
  }
  for (const [id, key] of Object.entries({ "reduced-motion-checkbox": "reducedMotion", "maximize-on-start-checkbox": "maximizeOnStart", "auto-refresh-logs-checkbox": "autoRefreshLogs", "show-service-summary-checkbox": "showServiceSummary", "keyboard-shortcuts-checkbox": "keyboardShortcuts", "log-wrap-checkbox": "logWrap" })) {
    document.getElementById(id).addEventListener("change", (event) => persistSettingsPatch({ [key]: event.target.checked }));
  }
  document.getElementById("reset-appearance-button").addEventListener("click", () => {
    const { theme, density, textSize, sidebarWidth, detailLevel, reducedMotion, uiFont, contentWidth, borderContrast } = window.corePreferences.defaults;
    persistSettingsPatch({ theme, density, textSize, sidebarWidth, detailLevel, reducedMotion, uiFont, contentWidth, borderContrast });
  });
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      setButtonPressed(button);
      persistSettingsPatch({ theme: button.getAttribute("data-theme-choice") || "midnight" });
    });
  });

  defaultViewSelect?.addEventListener("change", (event) => {
    persistSettingsPatch({ defaultView: event.target.value });
  });

  autoFocusPreviewCheckbox?.addEventListener("change", (event) => {
    persistSettingsPatch({ autoFocusPreview: event.target.checked });
  });

  rememberLastViewCheckbox?.addEventListener("change", (event) => {
    persistSettingsPatch({ rememberLastView: event.target.checked });
  });

  document.addEventListener("keydown", (event) => {
    const editing = Boolean(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
    const modalOpen = Boolean(document.querySelector('[role="dialog"]:not(.hidden)'));
    const target = window.coreWorkspaceTools.navigationShortcut(event, getCurrentPreferences().keyboardShortcuts, editing, modalOpen);
    if (!target) return;
    event.preventDefault();
    // Reuse normal navigation so iframe and unsaved-edit guards also apply to shortcuts.
    document.querySelector(`.nav-button[data-view-target="${target}"]`)?.click();
  });

}

function configurePolling() {
  clearInterval(statusPollTimer);
  clearInterval(logPollTimer);
  pollingStarted = true;
  statusPollInterval = currentPreferences.statusInterval;
  logPollInterval = currentPreferences.logInterval;
  statusPollTimer = setInterval(() => {
    if (!isBusy && nativeWindowVisible && !document.hidden) void refreshStatuses().catch((error) => {
      summaryText.textContent = "Статусы не обновлены";
      setDiagnostics(`Ошибка обновления статусов: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, statusPollInterval);
  logPollTimer = setInterval(() => {
    if (!nativeWindowVisible || document.hidden || !currentPreferences.autoRefreshLogs) return;
    void refreshActiveLog().catch((error) => setDiagnostics(`Не удалось прочитать журнал: ${error instanceof Error ? error.message : String(error)}`));
  }, logPollInterval);
}

function syncPollingVisibility() {
  const visible = nativeWindowVisible && !document.hidden;
  if (visible === windowPollingVisible) return;
  windowPollingVisible = visible;
  // Only the false -> true transition refreshes; overlapping native/DOM events must not double it.
  if (visible && pollingStarted && !isBusy) void refreshStatuses({ fresh: true }).catch(() => setDiagnostics("Не удалось обновить статусы после возврата в окно."));
}

async function bindWindowVisibility() {
  let revision = 0;
  const unsubscribe = launcherBridge.onWindowVisibility?.((visible) => {
    if (typeof visible !== "boolean") return;
    revision += 1;
    nativeWindowVisible = visible;
    syncPollingVisibility();
  });
  if (unsubscribe) window.addEventListener("unload", unsubscribe, { once: true });
  document.addEventListener("visibilitychange", syncPollingVisibility);
  const initialRevision = revision;
  try {
    const visible = await launcherBridge.getWindowVisibility?.();
    // A slow initial IPC reply must not overwrite a later hide/minimize event.
    if (revision === initialRevision && typeof visible === "boolean") nativeWindowVisible = visible;
    syncPollingVisibility();
  } catch {
    setDiagnostics("Состояние окна недоступно; используется проверка видимости страницы.");
  }
}

function renderGitPreview() {
  const running = ["preparing", "building", "starting", "ready", "stopping"].includes(gitPreviewState.phase);
  const matches = gitPreviewState.clientId === getStoredPreviewClientId();
  const ready = gitPreviewState.phase === "ready" && matches;
  pointInspector?.setReady(ready);
  document.getElementById("git-preview-status").textContent = gitPreviewError || (running && !matches
    ? "Запущен просмотр другого клиента. Сначала остановите и очистите его, затем запустите выбранного."
    : gitPreviewState.message);
  document.getElementById("git-preview-version").textContent = gitPreviewState.revision
    ? `${gitPreviewState.repositoryUrl} · commit ${gitPreviewState.revision.slice(0, 12)} · ${gitPreviewState.presentationMode === "source" ? "исходный вид Git" : "оформление клиента"} · локальная копия, не хост`
    : "Источник: полученный код Git. Старая адаптированная страница больше не используется.";
  document.getElementById("git-preview-start").disabled = gitPreviewAction || running || !getStoredPreviewClientId() || !launcherBridge?.startGitPreview;
  document.getElementById("git-preview-stop").disabled = gitPreviewAction || !running || ["preparing", "stopping"].includes(gitPreviewState.phase);
  for (const id of ["git-preview-admin", "git-preview-system"]) document.getElementById(id).disabled = gitPreviewAction || !ready;
}

function bindGitPreview() {
  if (window.CorePointInspector && launcherBridge?.getPointEditor) pointInspector = window.CorePointInspector.create({ bridge: launcherBridge, layout: syncLmsViewerBounds });
  const stateChanged = async (state) => {
    gitPreviewError = ""; gitPreviewState = state; renderGitPreview(); syncBrowserFrame(lastStatuses);
    if (state.phase === "ready" && !gitPreviewOpening) {
      gitPreviewOpening = true;
      try { await launcherBridge.showGitPreview(); syncLmsViewerBounds(); }
      catch { document.getElementById("git-preview-status").textContent = "LMS запущена, но окно не открыто. Остановите просмотр и повторите запуск."; }
      finally { gitPreviewOpening = false; }
    }
  };
  launcherBridge?.onGitPreviewState?.(stateChanged);
  if (launcherBridge?.getGitPreview) void launcherBridge.getGitPreview().then(stateChanged).catch(() => { document.getElementById("git-preview-status").textContent = "Не удалось прочитать состояние Git-просмотра."; });
  const action = async (callback) => {
    if (gitPreviewAction) return;
    gitPreviewAction = true; gitPreviewError = ""; renderGitPreview();
    try { await callback(); }
    catch (error) { gitPreviewError = error instanceof Error ? error.message : "Не удалось выполнить действие."; }
    finally { gitPreviewAction = false; renderGitPreview(); }
  };
  document.getElementById("git-preview-start").addEventListener("click", () => action(async () => {
    const source = await launcherBridge.getSourceState();
    if (source.phase !== "ready" || !source.snapshot) throw Error("Сначала откройте «Источник Git» и получите код репозитория. Повторного скачивания для уже полученной версии не нужно.");
    await launcherBridge.startGitPreview(getStoredPreviewClientId(), source.snapshot.id);
  }));
  document.getElementById("git-preview-stop").addEventListener("click", () => action(() => launcherBridge.stopGitPreview()));
  document.getElementById("git-preview-repository").addEventListener("click", () => setActiveView("repository"));
  for (const [id, role] of [["git-preview-admin", "admin"], ["git-preview-system", "system"]]) document.getElementById(id).addEventListener("click", () => action(() => launcherBridge.loginGitPreview(role)));
  new ResizeObserver(syncLmsViewerBounds).observe(document.getElementById("native-git-view-host"));
}

function bindBrowserControls() {
  const remove = document.getElementById("delete-client-button");
  remove.addEventListener("click", async () => {
    if (remoteBusy || document.body.dataset.clientDeleting === "true" || !launcherBridge?.deleteClient) return;
    if (!await canLeaveDeployPanel()) return;
    const clientId = getStoredPreviewClientId();
    if (!clientId) return;
    document.body.dataset.clientDeleting = "true";
    remove.disabled = true;
    remove.textContent = "Удаление...";
    showBrowserNavigationWarning("Проверяю клиента. Удаление начнется только после отдельного подтверждения.");
    const credentials = { mode: document.getElementById("remote-auth-mode").value, password: document.getElementById("remote-password").value,
      identityFile: document.getElementById("remote-identity-file").value, passphrase: document.getElementById("remote-passphrase").value };
    try {
      const result = await launcherBridge.deleteClient(clientId, readRemoteTarget(), credentials);
      if (result.phase === "cancelled") { showBrowserNavigationWarning("Удаление отменено. Клиент и сервер не изменены."); return; }
      if (result.phase !== "deleted" || result.clientId !== clientId) throw Error("Удаление не подтверждено; проверьте журнал Core.");
      if (getStoredPreviewClientId() === clientId) {
        setStoredPreviewClientId(""); setStoredPreviewClientName(""); browserClientIdInput.value = "";
        panelSelection.invalidate(); panelContextTargetUrl = "";
        newInstallationPlan = null; newInstallationState = null; uninstallationState = null;
        const url = buildBrowserUrl("deploy");
        preparePanelFrameContext(url); embeddedPanelFrame.src = url; embeddedPanelFrame.dataset.targetUrl = url;
      }
      previewClients = previewClients.filter(client => client.id !== clientId);
      showBrowserNavigationWarning("Клиент и его данные удалены. Если LMS была установлена через Core, ее выделенная БД удалена; резервная копия сохранена.");
    } catch (error) { showBrowserNavigationWarning(error instanceof Error ? error.message : "Не удалось удалить клиента. Карточка не скрыта; проверьте результат."); }
    finally {
      delete credentials.password; delete credentials.passphrase;
      document.body.dataset.clientDeleting = "false"; remove.textContent = "Удалить клиента и БД"; updatePreviewClientCaption();
    }
  });
  launcherBridge.onClientDeletionProgress?.(state => {
    if (document.body.dataset.clientDeleting === "true" && state.clientId === getStoredPreviewClientId()) showBrowserNavigationWarning(state.message);
  });
  browserTabDeploy?.addEventListener("click", () => {
    setButtonPressed(browserTabDeploy);
    setBrowserMode("deploy");
  });

  browserTabPreview?.addEventListener("click", () => {
    setButtonPressed(browserTabPreview);
    if (getStoredPreviewClientId()) {
      setBrowserMode("preview");
    } else {
      void choosePreviewClient();
    }
  });

  choosePreviewClientButton?.addEventListener("click", () => {
    setButtonPressed(choosePreviewClientButton);
    void choosePreviewClient();
  });

  toggleBrowserFocusButton?.addEventListener("click", () => {
    setButtonPressed(toggleBrowserFocusButton);
    setBrowserFocusMode(!isBrowserFocusMode);
  });

  reloadEmbeddedPanelButton?.addEventListener("click", async () => {
    setButtonPressed(reloadEmbeddedPanelButton);
    const navigation = ++browserNavigationRevision;
    if (!await canLeaveDeployPanel() || navigation !== browserNavigationRevision) return;
    if (activeBrowserMode === "remote") { await launcherBridge.reloadLmsViewer(); return; }
    if (activeBrowserMode === "preview") { await launcherBridge.reloadGitPreview?.(); return; }
    if (embeddedPanelFrame) {
      embeddedPanelFrame.dataset.targetUrl = "";
      deployAppearanceReady = false;
      embeddedPanelFrame.src = "about:blank";
      window.setTimeout(() => syncBrowserFrame(lastStatuses), 80);
    }

    await refreshActiveLog();
  });

  startEmbeddedPanelButton?.addEventListener("click", async () => {
    setButtonPressed(startEmbeddedPanelButton);
    setButtonWorking(startEmbeddedPanelButton, true);

    const targetServiceId = activeBrowserMode === "deploy" ? "deploy-panel" : "lms-web";

    try {
      const currentService = lastStatuses.find((service) => service.id === targetServiceId);
      if (currentService?.running) {
        await refreshStatuses({ fresh: true });
        const checked = lastStatuses.find((service) => service.id === targetServiceId);
        setDiagnostics(checked?.healthState === "healthy" ? `${targetServiceId}: готовность подтверждена.` : `${targetServiceId}: готовность пока не подтверждена. Проверьте журнал сервиса.`);
        return;
      }
      const result = await launcherBridge.startService(targetServiceId);
      await refreshStatuses({ fresh: true });
      syncBrowserFrame(lastStatuses);
      if (result.ok === false || !result.running) {
        throw new Error(result.message || "Порт сервиса не открылся.");
      }
      setDiagnostics(`${targetServiceId}: запуск выполнен.`);
    } catch (error) {
      setDiagnostics(`Ошибка запуска ${targetServiceId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setButtonWorking(startEmbeddedPanelButton, false);
    }
  });
}

function readRepositoryForm() {
  return {
    url: document.getElementById("repository-url").value,
    branch: document.getElementById("repository-branch").value,
    identityMode: document.getElementById("repository-identity-mode").value,
    identityFile: document.getElementById("repository-identity-file").value
  };
}

function repositoryFeedback(message, tone = "neutral") {
  const feedback = document.getElementById("repository-feedback");
  feedback.textContent = message;
  feedback.dataset.tone = tone;
}

function updateRepositoryIdentity() {
  document.getElementById("repository-file-row").classList.toggle("hidden", readRepositoryForm().identityMode !== "file");
}

function renderRepositoryKey(key) {
  document.getElementById("repository-public-key").value = key?.publicKey || "";
  document.getElementById("repository-key-fingerprint").textContent = key?.available ? key.fingerprint : "Ключ Core пока не создан.";
  document.getElementById("repository-copy-public-key").disabled = repositoryBusy || !key?.available;
  const create = document.getElementById("repository-create-key");
  create.disabled = repositoryBusy || Boolean(key?.available);
  create.textContent = key?.available ? "Отдельный ключ Core создан" : "Создать отдельный ключ Core";
}

function setRepositoryBusy(value) {
  repositoryBusy = value;
  document.querySelectorAll("#repository-form input, #repository-form select, #repository-form button, #repository-key-details button").forEach((control) => {
    control.disabled = value;
  });
  document.getElementById("repository-form").setAttribute("aria-busy", String(value));
  document.getElementById("repository-check").textContent = value ? "Проверяю доступ..." : "Сохранить и проверить";
  renderRepositoryKey(repositoryState?.key);
  document.getElementById("source-fetch-button").disabled = value;
}

function showRepositoryState(state, populateForm = true) {
  repositoryState = state;
  if (populateForm) {
    document.getElementById("repository-url").value = state.config.url;
    document.getElementById("repository-branch").value = state.config.branch;
    document.getElementById("repository-identity-mode").value = state.config.identityMode;
    document.getElementById("repository-identity-file").value = state.config.identityFile;
  }
  updateRepositoryIdentity();
  renderRepositoryKey(state.key);
  const result = state.result;
  const checkedAt = result?.checkedAt ? new Date(result.checkedAt).toLocaleString("ru-RU") : "Не выполнялась";
  document.getElementById("repository-checked-at").textContent = checkedAt;
  document.getElementById("repository-default-branch").textContent = result?.defaultBranch || "Не определена";
  document.getElementById("repository-selected-branch").textContent = result?.selectedBranch || "Не определена";
  document.getElementById("repository-revision").textContent = result?.revision || "Не получена";
  document.getElementById("repository-branches").replaceChildren(...(result?.branches || []).map((name) => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));
  repositoryFeedback(result?.message || "Подключение еще не проверялось.", result ? result.status === "connected" ? "success" : "error" : "neutral");
  sourceLibraryController?.render();
  if (sourceState) renderSourceState(sourceState);
}

async function loadRepositoryState() {
  try {
    showRepositoryState(await launcherBridge.getRepository());
  } catch (error) {
    repositoryFeedback(`Настройки репозитория не загружены: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function renderSourceState(state) {
  sourceState = state;
  const panel = document.querySelector(".source-version-panel");
  panel.dataset.phase = state.phase;
  const snapshot = state.snapshot;
  const form = readRepositoryForm();
  const matches = snapshot && snapshot.repositoryUrl === form.url.trim() && snapshot.requestedBranch === form.branch.trim();
  document.getElementById("source-fetch-feedback").textContent = state.phase === "ready" && snapshot && !matches ?
    "Сохранена версия другого источника или ветки. Для текущих настроек получите код заново." : state.message;
  document.getElementById("source-fetch-version").textContent = snapshot ?
    `${snapshot.branch} · ${snapshot.revision.slice(0, 12)} · ${snapshot.fileCount} файлов · ${(snapshot.archiveBytes / 1024 / 1024).toFixed(1)} MiB${matches ? "" : " · предыдущая версия"}` : "";
  document.getElementById("source-details").classList.toggle("hidden", !snapshot);
  document.getElementById("source-fetch-path").textContent = snapshot ?
    `${snapshot.project.kind === "nextjs" ? "Next.js" : "Тип проекта требует настройки"} / ${snapshot.project.packageManager}\n${snapshot.sourcePath}\nSHA256 архива: ${snapshot.archiveSha256}` : "";
  document.getElementById("source-fetch-warnings").replaceChildren(...(snapshot?.warnings || []).map((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    return item;
  }));
  renderNewInstallationPlan();
}

async function loadSourceState() {
  try {
    const state = await launcherBridge.getSourceState();
    renderSourceState(state);
    if (state.phase === "working") { sourceIsWorking = true; setRepositoryBusy(true); }
  } catch (error) {
    document.getElementById("source-fetch-feedback").textContent = `Не удалось прочитать состояние кода: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function readRemoteTarget() {
  const target = { host: document.getElementById("remote-host").value, port: Number(document.getElementById("remote-port").value),
    username: document.getElementById("remote-username").value, basePath: document.getElementById("remote-base-path").value,
    appPath: document.getElementById("remote-app-path").value,
    fingerprint: document.getElementById("remote-fingerprint").value };
  return document.getElementById("remote-operation-mode").value === "new" ? target : window.coreDeploymentWorkflow.installedUpdateTarget(target, newInstallationState, getStoredPreviewClientId());
}

// Clearing a window field is not the same as removing an encrypted saved password.
function clearRemoteCredentials() {
  for (const id of ["remote-password", "remote-passphrase"]) {
    const field = document.getElementById(id);
    if (field) field.value = "";
  }
}

async function loadRemoteTarget() {
  if (serverAccess) { await serverAccess.load(); renderNewInstallationPlan(); if (launcherBridge.getDeploymentState && getStoredPreviewClientId()) renderDeploymentState(await launcherBridge.getDeploymentState(getStoredPreviewClientId())); return; }
  try {
    const state = await launcherBridge.getRemoteState();
    const target = state.target;
    const previous = readRemoteTarget();
    if (["host", "port", "username", "fingerprint"].some((key) => previous[key] !== target[key])) clearRemoteCredentials();
    document.getElementById("remote-host").value = target.host;
    document.getElementById("remote-port").value = target.port;
    document.getElementById("remote-username").value = target.username;
    document.getElementById("remote-base-path").value = target.basePath;
    document.getElementById("remote-app-path").value = target.appPath || "";
    document.getElementById("remote-fingerprint").value = target.fingerprint;
    if (target.fingerprint) document.getElementById("remote-candidate").textContent = `Сохранён подтверждённый отпечаток: ${target.fingerprint}`;
    if (state.inventory) {
      renderRemoteInventory(state.inventory);
      document.getElementById("remote-feedback").textContent = `Последний успешный SSH-вход: ${new Date(state.inventory.checkedAt).toLocaleString("ru-RU")}. Это сохранённый результат, не постоянное соединение.`;
    }
    if (state.preflight) renderRemotePreflight(state.preflight);
    if (launcherBridge.getDeploymentState) renderDeploymentState(await launcherBridge.getDeploymentState());
    renderNewInstallationPlan();
  } catch (error) {
    document.getElementById("remote-feedback").textContent = `SSH-настройки не загружены: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function renderRemoteInventory(result) {
  const projects = result.projectPaths.filter((file) => !/\/(?:\.next|node_modules|\.git)\//.test(file));
  document.getElementById("remote-inventory").textContent = `${result.os} / ${result.user}\nNode: ${result.node} / npm: ${result.npm}\nСостояния стандартных служб: PostgreSQL ${result.postgres}; MySQL ${result.mysql}; MariaDB ${result.mariadb}\nНайдены каталоги проектов:\n${projects.join("\n") || "В стандартных каталогах не найдены"}`;
}

function renderRemotePreflight(result) {
  if (result.kind === "managed") {
    document.getElementById("remote-preflight-result").textContent = `Установка Core подтверждена: ${result.appRoot}\nЗапуск: systemd; данные: PostgreSQL\nHTTP-порт: ${result.webPort}\nОбновление не требует повторного ввода администраторов или создания БД. Новый Git-код будет собран отдельно, перед переключением сохранится прежняя LMS.\nПроверено: ${new Date(result.checkedAt).toLocaleString("ru-RU")}`;
    return;
  }
  const managers = [...result.managers.pm2.map((item) => `PM2: ${item.name} (${item.status})`), ...result.managers.systemd.map((item) => `systemd: ${item.name}`)];
  const dataBytes = result.protectedPaths.reduce((total, item) => total + item.bytes, 0);
  document.getElementById("remote-preflight-result").textContent = `Предварительная проверка: ${new Date(result.checkedAt).toLocaleString("ru-RU")}\nУстановка: ${result.appRoot}\nРежим данных: ${result.backend}; проект ${result.projectKind} / ${result.packageManager}\n${managers.join("\n") || "Процесс запуска не определён"}\nДанные: ${(dataBytes / 1024 / 1024).toFixed(1)} MiB; файлов окружения: ${result.environmentFiles.length}\nСвободно на диске: ${(result.diskFreeBytes / 1024 ** 3).toFixed(1)} GiB; RAM всего: ${(result.memoryTotalBytes / 1024 ** 3).toFixed(1)} GiB\n${result.warnings.join("\n") || "Дополнительных предупреждений нет. Backup и обновление ещё не выполнялись."}`;
}

function renderDeploymentState(state) {
  const element = document.getElementById("remote-deployment-result");
  if (!state) { element.textContent = "Обновления через Core ещё не выполнялись."; return; }
  if (!window.coreDeploymentWorkflow.matchesUpdateTarget(state.target, readRemoteTarget())) {
    element.textContent = "Сохраненное обновление относится к другой SSH-цели. Для выбранного сервера выполните «Проверить результат» в режиме обновления.";
    element.dataset.phase = "other_target";
    return;
  }
  deploymentWorkflow?.progress("update", state);
  const names = { preparing: "Подготовка кода", connecting: "SSH-вход", uploading: "Загрузка кода", validating: "Проверка сервера", building: "Сборка", stopping: "Остановка LMS", backup: "Резервная копия", switching: "Переключение кода", starting: "Запуск", health: "Проверка сайта", rolling_back: "Восстановление", rolled_back: "Восстановлена прежняя версия", succeeded: "Готово", failed: "Ошибка", needs_attention: "Требуется проверка", disconnected: "Связь прервана" };
  const lines = [state.message, `Сервер: ${state.target.host} / ${state.target.appPath}`, `Задача: ${state.id}`, `Commit: ${state.revision || "подготовка"}`, `Этап: ${names[state.phase] || state.phase}`];
  if (state.port) lines.push(`HTTP-порт LMS: ${state.port}`);
  if (state.backupPath) lines.push(`Резервная копия: ${state.backupPath}`);
  if (state.errorCode) lines.push(`Код ошибки: ${state.errorCode}${state.failedStep ? `; этап: ${names[state.failedStep] || state.failedStep}` : ""}`);
  if (state.swapCreatedBytes) lines.push("Создан swap 4 GiB. Он останется активным до перезагрузки; файл автоматически не удаляется.");
  lines.push(`Обновлено: ${new Date(state.updatedAt).toLocaleString("ru-RU")}`);
  element.textContent = lines.join("\n");
  element.dataset.phase = state.phase;
}

function newInstallationMatches() {
  if (!newInstallationPlan || newInstallationPlan.client.id !== getStoredPreviewClientId()) return false;
  if (!["empty", "source"].includes(newInstallationPlan.contentMode) || document.getElementById("new-installation-content-mode").value !== newInstallationPlan.contentMode) return false;
  const snapshot = sourceState?.snapshot;
  const source = readRepositoryForm();
  if (sourceState?.phase !== "ready" || snapshot?.id !== newInstallationPlan.source.snapshotId || snapshot.repositoryUrl !== source.url.trim() || snapshot.requestedBranch !== source.branch.trim()) return false;
  const target = readRemoteTarget();
  return ["host", "username", "basePath", "fingerprint"].every((key) => target[key].trim() === newInstallationPlan.target[key]) && target.port === newInstallationPlan.target.port;
}

function installationServerCheckIsFresh(plan, now = Date.now()) {
  const age = now - Date.parse(plan?.preflight?.checkedAt || "");
  return Number.isFinite(age) && age >= 0 && age <= 10 * 60 * 1000;
}

function syncDeploymentWorkflow() {
  renderUninstallation();
  syncAiConfiguration();
  syncMailConfiguration();
  if (!deploymentWorkflow) return;
  const target = readRemoteTarget(), planReady = newInstallationMatches(), plan = planReady ? newInstallationPlan : null;
  const snapshot = sourceState?.snapshot, source = readRepositoryForm();
  const state = newInstallationState?.clientId === getStoredPreviewClientId() ? newInstallationState : null;
  const postgresReady = document.getElementById("install-db-mode").value !== "local_peer" || plan?.preflight?.postgresState === "ready";
  deploymentWorkflow.update({
    isNew: document.getElementById("remote-operation-mode").value === "new",
    clientReady: Boolean(repositoryTargetClientId && repositoryTargetClientId === getStoredPreviewClientId()),
    connectionReady: Boolean(target.host.trim() && target.username.trim() && target.fingerprint.trim()),
    sourceReady: Boolean(sourceState?.phase === "ready" && snapshot && snapshot.repositoryUrl === source.url.trim() && snapshot.requestedBranch === source.branch.trim()),
    planReady, packageReady: Boolean(plan?.package), hasPreflight: Boolean(plan?.preflight),
    fresh: installationServerCheckIsFresh(plan), prepared: postgresReady && plan?.status === "prepared" && !plan.checks.some(check => check.status === "blocked"),
    postgresIssue: !postgresReady && plan?.preflight ? plan.checks.find(check => check.code === "LOCAL_POSTGRES")?.message || "Повторите «Проверить сервер» для проверки PostgreSQL." : "",
    installed: state?.phase === "succeeded", running: Boolean(state && !["succeeded", "failed", "needs_attention", "disconnected"].includes(state.phase))
  });
}

function syncAiConfiguration() {
  if (!aiConfigurationController) return;
  const clientId = getStoredPreviewClientId(), target = readRemoteTarget(), installed = newInstallationState;
  const base = JSON.stringify([clientId, target.host, target.port, target.username, target.basePath, target.fingerprint]);
  if (base !== aiBaseContext) { aiBaseContext = base; aiKnownInstallation = ""; }
  if (installed?.clientId === clientId) aiKnownInstallation = `${installed.id}/${installed.releaseId}`;
  // A same-client profile refresh briefly clears installation state; keep its form draft.
  const context = base + "|" + aiKnownInstallation;
  const changed = aiConfigurationController.setContext(context);
  const ready = installed?.phase === "succeeded" && installed.clientId === clientId && ["host", "port", "username", "basePath", "fingerprint"].every(key => target[key] === installed.target[key]);
  document.getElementById("ai-configuration-panel").classList.toggle("hidden", !ready);
  aiConfigurationController.setEnabled(Boolean(ready), remoteBusy);
  if (ready && aiReceiptContext !== context && launcherBridge?.getAiConfiguration) {
    aiReceiptContext = context;
    void launcherBridge.getAiConfiguration(clientId).then(state => {
      if (aiConfigurationController.context() !== context || !state || state.clientId !== clientId || state.jobId !== installed.id || state.releaseId !== installed.releaseId || state.host !== target.host) return;
      aiConfigurationController.receive(state);
    }).catch(() => { if (aiConfigurationController.context() === context) setDiagnostics("Сохраненный результат ИИ не прочитан. Можно проверить настройки ИИ через SSH в этом же блоке."); });
  }
}

function syncMailConfiguration() {
  if (!mailConfigurationController) return;
  const clientId = getStoredPreviewClientId(), target = readRemoteTarget(), installed = newInstallationState;
  const base = JSON.stringify([clientId, target.host, target.port, target.username, target.basePath, target.fingerprint]);
  if (base !== mailBaseContext) { mailBaseContext = base; mailKnownInstallation = ""; }
  if (installed?.clientId === clientId) mailKnownInstallation = `${installed.id}/${installed.releaseId}`;
  const context = base + "|" + mailKnownInstallation;
  mailConfigurationController.setContext(context);
  const ready = installed?.phase === "succeeded" && installed.clientId === clientId && ["host", "port", "username", "basePath", "fingerprint"].every(key => target[key] === installed.target[key]);
  document.getElementById("mail-configuration-panel").classList.toggle("hidden", !ready);
  mailConfigurationController.setEnabled(Boolean(ready), remoteBusy);
  if (ready && mailReceiptContext !== context && launcherBridge?.getMailConfiguration) {
    mailReceiptContext = context;
    void launcherBridge.getMailConfiguration(clientId).then(state => {
      if (mailConfigurationController.context() !== context || !state || state.clientId !== clientId || state.jobId !== installed.id || state.releaseId !== installed.releaseId || state.host !== target.host) return;
      mailConfigurationController.receive(state);
    }).catch(() => { if (mailConfigurationController.context() === context) setDiagnostics("Сохраненный результат почты не прочитан. Можно прочитать настройки сервера в почтовом блоке."); });
  }
}

function renderNewInstallationPlan() {
  clearTimeout(installationCheckExpiryTimer);
  installationCheckExpiryTimer = null;
  const base = document.getElementById("remote-base-path").value.trim();
  const validSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(repositoryClientSlug) && repositoryClientSlug.length <= 40;
  document.getElementById("new-installation-auto-path").textContent = validSlug && base ? `${base.replace(/\/$/, "")}/${repositoryClientSlug}` : "Выберите клиента с корректным кодом";
  const status = document.getElementById("new-installation-status");
  const matches = newInstallationMatches();
  const plan = matches ? newInstallationPlan : null;
  const fresh = installationServerCheckIsFresh(plan);
  const postgresReady = document.getElementById("install-db-mode").value !== "local_peer" || plan?.preflight?.postgresState === "ready";
  // One deadline refresh, not polling: expire the button even while the form is idle.
  if (fresh) installationCheckExpiryTimer = setTimeout(renderNewInstallationPlan, Math.max(1, Date.parse(plan.preflight.checkedAt) + 10 * 60 * 1000 - Date.now() + 1));
  document.getElementById("new-installation-summary").classList.toggle("hidden", !plan);
  document.getElementById("new-installation-details").classList.toggle("hidden", !plan);
  document.getElementById("new-installation-server-check").disabled = remoteBusy || !plan || !plan.target.fingerprint;
  document.getElementById("new-installation-package").disabled = remoteBusy || !plan;
  document.getElementById("new-installation-content-mode").disabled = remoteBusy;
  document.getElementById("prepare-clean-server").disabled = remoteBusy || !plan || !plan.target.fingerprint || executionMode !== "remote" && !["127.0.0.1", "localhost"].includes(plan.target.host);
  document.getElementById("prepare-server-memory").disabled = document.getElementById("prepare-clean-server").disabled;
  document.getElementById("new-installation-start").disabled = remoteBusy || !fresh || !postgresReady || plan?.status !== "prepared" || executionMode !== "remote" && !["127.0.0.1", "localhost"].includes(plan?.target.host) || Boolean(newInstallationState && newInstallationState.phase !== "failed");
  document.getElementById("new-installation-refresh").disabled = remoteBusy || !newInstallationState || newInstallationState.clientId !== getStoredPreviewClientId();
  document.getElementById("new-installation-open-lms").disabled = remoteBusy || newInstallationState?.phase !== "succeeded";
  renderIpPublication();
  document.getElementById("new-installation-package-info").textContent = plan?.package ? `Пакет ${plan.package.id.slice(0, 8)} · ${(plan.package.archiveBytes / 1024 ** 2).toFixed(1)} МБ · commit ${plan.package.revision.slice(0, 12)}${plan.package.design ? ` · оформление ${plan.package.design.sha256.slice(0, 12)} · текстов: ${plan.package.design.supportedTextKeys.length} · изображений: ${plan.package.design.assetCount || 0}` : ""}` : "Пакет пока не подготовлен.";
  if (plan?.package) document.getElementById("new-installation-package-info").textContent += plan.contentMode === "source" ? ` · тем: ${plan.package.curriculum?.topics ?? 0} · тестов: ${plan.package.curriculum?.tests ?? 0} · вопросов: ${plan.package.curriculum?.questions ?? 0}` : " · пустая учебная база";
  document.getElementById("new-installation-blockers").replaceChildren();
  document.getElementById("new-installation-checks").replaceChildren();
  if (!plan) {
    status.textContent = newInstallationPlan ? "Клиент, Git, наполнение или SSH-параметры изменились. Подготовьте новый план перед проверкой." : "Выберите клиента, Git-код и наполнение, затем подготовьте план. Сервер на этом шаге не изменяется.";
    status.dataset.status = "pending";
    syncDeploymentWorkflow();
    return;
  }
  const blocked = plan.checks.filter((check) => check.status === "blocked");
  status.textContent = blocked.some((item) => item.code === "MEMORY") ? "Не хватает памяти для сборки. На шаге «Подготовка» раскройте окружение и память, добавьте swap отдельной кнопкой и повторите «Проверить сервер»." : blocked.some((item) => item.code === "RUNTIME") ? "Окружение не готово. На шаге «Подготовка» нажмите «Подготовить чистую Ubuntu», затем повторите «Проверить сервер»." : blocked.length ? "План сохранён. Устраните перечисленные ниже условия перед установкой." : plan.status === "prepared" ? "Пакет и сервер проверены. На шаге «Установка» заполните доступы и подтвердите запуск." : "На шаге «Подготовка» соберите пакет и выполните проверку сервера.";
  status.dataset.status = blocked.length ? "blocked" : plan.status === "prepared" ? "passed" : "pending";
  if (!blocked.length && !postgresReady && plan.preflight) {
    status.textContent = plan.checks.find(check => check.code === "LOCAL_POSTGRES")?.message || "Повторите «Проверить сервер» для проверки PostgreSQL.";
    status.dataset.status = "pending";
  }
  if (!blocked.length && plan.package && plan.preflight && !fresh && (!newInstallationState || newInstallationState.phase === "failed")) {
    status.textContent = "Срок SSH-проверки истёк (10 минут). На шаге «Подготовка» нажмите только «Проверить сервер». План и пакет сохранены, пересобирать их не нужно.";
    status.dataset.status = "pending";
  }
  document.getElementById("new-installation-client").textContent = plan.client.name;
  document.getElementById("new-installation-source").textContent = `${plan.source.branch} / ${plan.source.revision.slice(0, 12)} · Git + backend Core`;
  document.getElementById("new-installation-source").title = `${plan.source.repositoryUrl}\nВетка: ${plan.source.branch}\nCommit: ${plan.source.revision}\nИсходный интерфейс Git; storage/auth и поддержка адаптируются Core. Режим неизмененного Git пока не подключен.`;
  document.getElementById("new-installation-database").textContent = `PostgreSQL · ${plan.database.host || "хост не задан"}:${plan.database.port} / ${plan.database.name || "имя не задано"}`;
  document.getElementById("new-installation-server").textContent = plan.preflight ? `${new Date(plan.preflight.checkedAt).toLocaleString("ru-RU")} · ${plan.preflight.os} · ${fresh ? "действует 10 минут" : "повторите проверку сервера"}` : "Пока не проверен";
  for (const check of plan.checks) {
    const row = document.createElement("li");
    row.className = "installation-check";
    row.dataset.status = check.status;
    const label = document.createElement("strong");
    label.textContent = check.label;
    const message = document.createElement("span");
    message.textContent = check.message;
    row.append(label, message);
    document.getElementById("new-installation-checks").append(row);
    if (check.status === "blocked") {
      const blocker = document.createElement("li");
      blocker.textContent = check.message;
      document.getElementById("new-installation-blockers").append(blocker);
    }
  }
  syncDeploymentWorkflow();
}

async function loadNewInstallationPlan() {
  const request = ++newInstallationRequest;
  const clientId = getStoredPreviewClientId();
  newInstallationPlan = null;
  newInstallationState = null;
  document.getElementById("new-installation-content-mode").value = "";
  ipPublicationState = null;
  uninstallationState = null;
  renderNewInstallationState();
  renderNewInstallationPlan();
  if (!clientId || !launcherBridge.getInstallationPlan) return;
  try {
    const [{ plan, state, publication }, removal] = await Promise.all([
      window.coreWorkspaceTools.readInstallationSnapshot(launcherBridge, clientId),
      launcherBridge.getUninstallation ? launcherBridge.getUninstallation(clientId) : Promise.resolve(null)
    ]);
    if (request !== newInstallationRequest || clientId !== getStoredPreviewClientId()) return;
    newInstallationPlan = plan;
    newInstallationState = state;
    document.getElementById("new-installation-content-mode").value = plan?.contentMode || "";
    ipPublicationState = publication;
    uninstallationState = removal?.state || null;
    uninstallationAccepted = removal?.accepted === true;
    renderNewInstallationState();
    renderNewInstallationPlan();
  } catch {
    if (request === newInstallationRequest) document.getElementById("new-installation-status").textContent = "Сохранённый план не прочитан. Можно подготовить его заново; сервер не изменён.";
  }
}

function renderUninstallation() {
  const panel = document.getElementById("lms-removal-panel");
  if (!panel) return;
  const clientId = getStoredPreviewClientId(), installed = newInstallationState?.clientId === clientId && newInstallationState.phase === "succeeded";
  const state = uninstallationState?.clientId === clientId ? uninstallationState : null;
  panel.classList.toggle("hidden", !launcherBridge?.prepareUninstallation || !installed && !state);
  const matches = state && ["host", "port", "username", "basePath", "fingerprint"].every(key => state.target?.[key] === readRemoteTarget()[key]);
  const age = state ? Date.now() - Date.parse(state.checkedAt) : Infinity;
  document.getElementById("lms-removal-prepare").disabled = remoteBusy || !installed && !state?.archiveCompleted || state?.phase === "running" || state?.phase === "uninstalled";
  document.getElementById("lms-removal-execute").disabled = remoteBusy || !uninstallationAccepted || !installed && !state?.archiveCompleted || !matches || state.phase !== "checked" || age < 0 || age > 5 * 60 * 1000;
  document.getElementById("lms-removal-refresh").disabled = remoteBusy || !matches || state.phase === "checked";
  document.getElementById("lms-removal-readiness").textContent = uninstallationAccepted ? "Удаляет LMS вместе с ее БД и служебными учетками. Сначала проверенная резервная копия и отдельное подтверждение; карточка и доступы остаются. Проверка действует 5 минут." : "Удаление заблокировано до актуальной локальной Linux-проверки backup, удаления БД и готовности повторной установки.";
  const labels = { checked: state?.archiveCompleted ? "Архив уже есть. Подготовлено завершение полного удаления БД и служебной учетки." : "Проверка завершена. Сайт пока работает; после подтверждения будут созданы backup и удалены LMS с БД.", running: "Создаю backup, удаляю LMS, выделенную БД и служебную учетку...", uninstalled: "LMS и ее база данных удалены. Карточка и доступы сохранены; можно заново установить LMS.", failed: "Удаление не завершено.", needs_attention: "Полное удаление не подтверждено. Проверьте результат, затем повторите проверку удаления для безопасного продолжения." };
  const result = document.getElementById("lms-removal-result");
  result.textContent = state ? [labels[state.phase] || "Нужно проверить результат.", `Сервер: ${state.target.host} / ${state.appPath}`,
    ...(state.backupPath ? [`Резервная копия: ${state.backupPath}`] : []), ...(state.errorCode ? [`Код: ${state.errorCode}`] : []),
    ...(state.rollbackRestored === true ? ["Прежние файлы и службы восстановлены."] : []), `Обновлено: ${new Date(state.updatedAt).toLocaleString("ru-RU")}`].join("\n") : "Удаление выбранной LMS еще не проверялось.";
}

function renderNewInstallationState() {
  const state = newInstallationState, element = document.getElementById("new-installation-result");
  const recover = document.getElementById("recover-new-installation");
  recover.classList.toggle("hidden", !state?.retryAvailable || state.clientId !== getStoredPreviewClientId());
  recover.disabled = remoteBusy || !launcherBridge?.recoverInstallation;
  if (!state || state.clientId !== getStoredPreviewClientId()) { element.textContent = "Установка ещё не выполнялась."; syncDeploymentWorkflow(); return; }
  deploymentWorkflow?.progress("installation", state);
  element.textContent = [state.message, `Сервер: ${state.target.host} / ${state.target.appPath}`, `Commit: ${state.revision.slice(0, 12)}`, `Этап: ${window.coreDeploymentWorkflow.phaseLabel(state.phase)}`,
    ...(state.errorCode ? [`Ошибка: ${state.errorCode}`] : []), ...(state.phase === "succeeded" ? [`LMS внутри Linux: http://127.0.0.1:${state.webPort}`, "С ноутбука открывайте кнопкой «Открыть LMS через SSH». Публичный домен/HTTPS настраиваются отдельно."] : []),
    `Обновлено: ${new Date(state.updatedAt).toLocaleString("ru-RU")}`].join("\n");
  syncDeploymentWorkflow();
}

function renderIpPublication() {
  const installed = newInstallationState?.phase === "succeeded" && newInstallationState.clientId === getStoredPreviewClientId();
  document.getElementById("ip-publication-panel").classList.toggle("hidden", !installed);
  document.getElementById("ip-publication-check").disabled = remoteBusy || !installed;
  const state = ipPublicationState?.clientId === getStoredPreviewClientId() && ipPublicationState.host === newInstallationState?.target.host && ipPublicationState.jobId === newInstallationState?.id ? ipPublicationState : null;
  const https = state?.protocol === "https", canOpen = state?.phase === "succeeded" && state.url === `${https ? "https" : "http"}://${state.host}`;
  document.getElementById("ip-publication-start").disabled = remoteBusy || !installed || https;
  document.getElementById("ip-publication-start").classList.toggle("hidden", https);
  document.getElementById("ip-publication-https").disabled = remoteBusy || !installed || !(state?.phase === "succeeded" || https && state.errorCode && state.errorCode !== "PUBLICATION_RESULT_UNCONFIRMED");
  document.getElementById("ip-publication-https").textContent = https ? "Обновить HTTPS" : "Включить HTTPS";
  if (state) deploymentWorkflow?.progress("access", state);
  document.getElementById("ip-publication-open").disabled = remoteBusy || !canOpen;
  const labels = { publishing: https ? "Настраиваю сертификат, HTTPS и автопродление..." : "Настраиваю публичный HTTP-вход...", succeeded: "Nginx и LMS на сервере отвечают. Проверьте адрес в браузере; внешний firewall хостера проверяется отдельно.", failed: "Публикация не выполнена. Сама LMS не переустанавливалась.", needs_attention: "Требуется проверка. Нажмите «Проверить IP-доступ» для актуального состояния сервера." };
  const renew = { scheduled: "таймер включен, первый запуск ожидается", ok: "таймер включен, последний запуск успешен", failed: "ошибка последнего запуска; требуется проверка", inactive: "таймер выключен", unconfirmed: "не подтверждено" };
  const errors = { ACME_WEBROOT_UNREACHABLE: "Nginx не отдает проверочный файл на порту80.", ACME_WEBROOT_NOT_READABLE: "Nginx не может читать каталог проверки сертификата.", ACME_PUBLIC_IP_REQUIRED: "Для выпуска нужен публичный IPv4-адрес.", TLS_CERTIFICATE_EXPIRED: "Срок сертификата истек. Нажмите «Обновить HTTPS».", TLS_RENEWAL_NOT_ACTIVE: "Автопродление не включено или не подтверждено.", TLS_RENEWAL_FAILED: "Последнее автоматическое продление завершилось ошибкой.", TLS_HEALTH_FAILED: "Не подтвержден защищенный ответ установленной LMS.", HTTPS_PORT_OCCUPIED: "Порт443 занят другой программой.", NGINX_CONFIG_OCCUPIED: "Конфигурация отличается от созданной Core. Она не перезаписывалась." };
  Object.assign(errors, { ACME_RATE_LIMITED: "Удостоверяющий центр ограничил повторные запросы. Не повторяйте выпуск вслепую; нужно дождаться снятия лимита.", ACME_VALIDATION_FAILED: "Удостоверяющий центр не подтвердил доступ к IP. Проверьте внешний порт80 и firewall хостера.", ACME_CONNECTION_FAILED: "Сервер не смог связаться с удостоверяющим центром. Проверьте сеть и DNS сервера.", ACME_ISSUANCE_FAILED: "Сертификат не выпущен. Проверьте доступность порта80 из интернета и сетевые ограничения сервера." });
  Object.assign(errors, { ACME_DIRECTORY_TLS_FAILED: "Не подтверждена подлинность HTTPS-соединения с центром сертификатов. Проверка TLS не отключалась.", ACME_DIRECTORY_INVALID: "Центр сертификатов вернул неподтвержденный ответ. Выпуск остановлен.", ACME_PROFILE_UNAVAILABLE: "Рабочий центр не подтвердил профиль сертификатов для IP." });
  document.getElementById("ip-publication-result").textContent = state ? [labels[state.phase] || "Результат неизвестен.", ...(state.url ? [state.url] : []), ...(https ? [state.phase === "succeeded" ? "HTTPS: соединение проверено." : "HTTPS настроен, но защищенный доступ сейчас не подтвержден.", ...(state.expiresAt ? [`Сертификат до: ${new Date(state.expiresAt).toLocaleString("ru-RU")}`] : []), `Продление: ${renew[state.renewalState] || "не подтверждено"}`] : canOpen ? ["HTTP без шифрования: только для теста."] : []), ...(state.errorCode ? [errors[state.errorCode] || `Код: ${state.errorCode}${state.failedStep ? `; этап: ${state.failedStep}` : ""}`] : []), ...(state.rollback === true ? ["Прежний конфиг восстановлен; перепроверьте доступ."] : []), `Последняя проверка: ${new Date(state.updatedAt).toLocaleString("ru-RU")}`].join("\n") : "Публичный вход ещё не настроен. Сначала опубликуйте по IP, затем включите HTTPS.";
  if (state?.phase === "succeeded" && state.stagingCheck === "unavailable") document.getElementById("ip-publication-result").textContent += "\nТестовый центр был недоступен. Сертификат выпущен рабочим центром с проверкой владения IP.";
}

function updateRemoteOperationMode() {
  const isNew = document.getElementById("remote-operation-mode").value === "new";
  if (!isNew && !document.getElementById("remote-app-path").value) document.getElementById("remote-app-path").value = readRemoteTarget().appPath || "";
  for (const id of ["remote-app-path-row", "remote-existing-checks", "remote-update-actions", "remote-preflight-result", "remote-inventory", "repository-target-legacy-summary"]) {
    document.getElementById(id).classList.toggle("hidden", isNew);
  }
  document.getElementById("new-installation-panel").classList.toggle("hidden", !isNew);
  const managed = !isNew && newInstallationState?.phase === "succeeded" && newInstallationState.clientId === getStoredPreviewClientId();
  document.getElementById("remote-allow-swap").closest("label").classList.toggle("hidden", managed);
  document.getElementById("new-installation-destination").classList.toggle("hidden", !isNew);
  document.getElementById("remote-mode-note").textContent = isNew ? "Для новой установки путь рассчитывается из кода клиента. Существующий сайт не заменяется." : "Обновление — отдельный режим для уже работающей LMS. Прежние данные и окружение сохраняются.";
  renderNewInstallationPlan();
}

async function withRemoteCredentials(operation) {
  const target = readRemoteTarget();
  if (!target.fingerprint) throw new Error("Сначала укажите сверенный через консоль хостера отпечаток. Пароль пока не отправлялся.");
  const credentials = { mode: document.getElementById("remote-auth-mode").value,
    password: document.getElementById("remote-password").value, identityFile: document.getElementById("remote-identity-file").value,
    passphrase: document.getElementById("remote-passphrase").value };
  try {
    if (serverAccess) {
      await serverAccess.saveTarget();
      if (credentials.mode === "password" && !credentials.password && serverAccess.isSaved()) credentials.savedForClient = getStoredPreviewClientId();
    } else await launcherBridge.saveRemoteTarget(target);
    await operation(target, credentials);
  } finally { credentials.password = ""; credentials.passphrase = ""; }
}

async function runRemoteAction(operation) {
  const form = document.getElementById("remote-target-form");
  if (remoteBusy || !(deploymentWorkflow ? deploymentWorkflow.revealInvalid(form) : form.reportValidity())) return;
  remoteBusy = true;
  syncAiConfiguration();
  syncMailConfiguration();
  const workflowAction = deploymentWorkflow?.begin();
  const feedback = document.getElementById("remote-feedback");
  const pendingMessage = "Выполняется выбранная команда. Текущий этап и итог отображаются ниже.";
  feedback.textContent = pendingMessage;
  let failed = false;
  let cancelled = false;
  const controls = document.querySelectorAll("#remote-target-form input, #remote-target-form select, #remote-target-form button");
  controls.forEach((control) => { control.disabled = true; });
  try { await operation(); if (feedback.textContent === pendingMessage) feedback.textContent = "Команда завершена. Проверьте её итог в блоке результата ниже."; }
  catch (error) { failed = true; const message = error instanceof Error ? error.message : String(error); cancelled = window.coreDeploymentWorkflow.isCancellation(message); document.getElementById("remote-feedback").textContent = message; }
  finally { remoteBusy = false; controls.forEach((control) => { control.disabled = false; }); serverAccess?.refresh(); renderNewInstallationPlan(); if (workflowAction) deploymentWorkflow.end(workflowAction, failed, cancelled); }
}

function bindRemoteControls() {
  document.getElementById("recover-new-installation").addEventListener("click", () => {
    const clientId = getStoredPreviewClientId();
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      const result = await launcherBridge.recoverInstallation(clientId, target, credentials);
      if (getStoredPreviewClientId() === clientId) newInstallationState = result;
      document.getElementById("remote-feedback").textContent = result.message; renderNewInstallationState();
    }));
  });
  launcherBridge.onPackagePreparationProgress?.(value => {
    if (remoteBusy && sourceState?.snapshot?.id === value.snapshotId) document.getElementById("remote-feedback").textContent = value.message;
  });
  deploymentWorkflow = window.coreDeploymentWorkflow.create(document);
  aiConfigurationController = window.coreAiConfiguration.create(document);
  mailConfigurationController = window.coreMailConfiguration.create(document);
  deploymentWorkflow.setContext(getStoredPreviewClientId());
  const feedback = document.getElementById("remote-feedback");
  for (const [id, action] of [["lms-removal-prepare", "prepare"], ["lms-removal-execute", "execute"], ["lms-removal-refresh", "refresh"]]) document.getElementById(id).addEventListener("click", () => {
    const clientId = getStoredPreviewClientId(), operationId = uninstallationState?.operationId;
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      feedback.textContent = action === "prepare" ? "Проверяю владельца установки, службы и возможность backup. Ничего не останавливаю..." : action === "execute" ? "Ожидается отдельное подтверждение точного клиента и сервера..." : "Читаю серверный результат удаления...";
      const state = action === "prepare" ? await launcherBridge.prepareUninstallation(clientId, target, credentials) : action === "execute" ? await launcherBridge.executeUninstallation(clientId, operationId, target, credentials) : await launcherBridge.refreshUninstallation(clientId, target, credentials);
      if (clientId !== getStoredPreviewClientId()) return;
      uninstallationState = state;
      if (state.phase === "uninstalled") { newInstallationState = null; ipPublicationState = null; lmsViewerState = { phase: "closed" }; renderNewInstallationState(); }
      renderNewInstallationPlan(); renderUninstallation(); deploymentWorkflow.progress("removal", state);
      feedback.textContent = state.phase === "uninstalled" ? "LMS, выделенная БД и служебная учетка удалены. Карточка и доступы остаются; для новой установки обновите план и проверку сервера." : state.phase === "checked" ? "Проверка пройдена. Подтвердите отдельную команду удаления LMS вместе с БД." : "Смотрите результат полного удаления; до его подтверждения новая установка заблокирована.";
    }));
  });
  if (launcherBridge.getClientServer) serverAccess = window.coreServerAccess.createServerAccess({
    bridge: launcherBridge, clientId: getStoredPreviewClientId, readTarget: readRemoteTarget,
    authMode: () => document.getElementById("remote-auth-mode").value, isBusy: () => remoteBusy,
    field: document.getElementById("remote-password"), button: document.getElementById("remote-password-lock"), note: document.getElementById("remote-password-note"),
    setLoading: (loading) => {
      for (const id of ["remote-host", "remote-port", "remote-username", "remote-base-path", "remote-app-path", "remote-fingerprint", "remote-password", "remote-auth-mode", "remote-identity-file", "remote-passphrase", "remote-save-button"]) document.getElementById(id).disabled = loading;
    },
    applyTarget: (target) => {
      const values = target || { host: "", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "", fingerprint: "" };
      for (const [id, key] of [["remote-host", "host"], ["remote-port", "port"], ["remote-username", "username"], ["remote-base-path", "basePath"], ["remote-app-path", "appPath"], ["remote-fingerprint", "fingerprint"]]) document.getElementById(id).value = values[key] ?? "";
      document.getElementById("remote-candidate").textContent = values.fingerprint ? `Сохранён подтверждённый отпечаток: ${values.fingerprint}` : "Сначала получите и независимо сверьте SSH-отпечаток.";
      for (const id of ["remote-inventory", "remote-preflight-result"]) document.getElementById(id).textContent = "";
      document.getElementById("remote-passphrase").value = "";
      document.getElementById("remote-identity-file").value = "";
      document.getElementById("remote-auth-mode").value = "password";
      document.getElementById("remote-password-row").classList.remove("hidden");
      document.getElementById("remote-key-row").classList.add("hidden");
      document.getElementById("remote-allow-swap").checked = false;
      syncDeploymentWorkflow();
    },
    seedTarget: async (id) => {
      const installed = await launcherBridge.getInstallationState(id);
      if (installed?.clientId === id && installed.target) return installed.target;
      const plan = await launcherBridge.getInstallationPlan(id);
      return plan?.client?.id === id ? plan.target : null;
    },
    onError: (error) => { feedback.textContent = `SSH-доступ: ${error instanceof Error ? error.message : String(error)}`; }
  });
  for (const [buttonId, checkOnly, provision] of [["ai-configuration-apply", false, false], ["ai-configuration-check", true, false], ["ai-configuration-provision", false, true]]) document.getElementById(buttonId).addEventListener("click", () => {
    const installed = newInstallationState, clientId = getStoredPreviewClientId(), context = aiConfigurationController.context();
    if (installed?.phase !== "succeeded" || installed.clientId !== clientId) return;
    const settings = checkOnly ? {} : aiConfigurationController.values();
    const issue = checkOnly ? null : aiConfigurationController.issue(provision);
    if (issue) { feedback.textContent = issue.message; deploymentWorkflow.showResult("ai"); document.getElementById(issue.id).focus(); return; }
    void runRemoteAction(async () => {
      try {
        await withRemoteCredentials(async (target, credentials) => {
          feedback.textContent = checkOnly ? "Проверяю наличие настроек ИИ и состояние LMS. Платный ИИ не вызывается..." : provision ? "Ожидается подтверждение создания своей пустой базы знаний и применения настроек. Генерация и загрузка файлов не выполняются..." : "Ожидается подтверждение записи параметров ИИ и перезапуска веб-службы...";
          const result = provision ? await launcherBridge.provisionLmsAi(clientId, target, credentials, settings) : await launcherBridge.configureLmsAi(clientId, target, credentials, settings, checkOnly);
          if (getStoredPreviewClientId() !== clientId || aiConfigurationController.context() !== context) return;
          aiConfigurationController.receive(result, !checkOnly);
          deploymentWorkflow.progress("ai", result);
          feedback.textContent = result.phase === "applied" ? "Параметры записаны. Подключение к ИИ НЕ проверено: нужен настоящий запрос в LMS и действующие ID ресурсов Яндекса." : result.phase === "checked" ? "Наличие настроек прочитано. Подключение к ИИ, ключ и права НЕ проверены; токен обратно в Core не передается." : "Изменение ИИ не подтверждено. Смотрите результат и состояние отката.";
        });
      } finally { if (settings) delete settings.AI_API_KEY; }
    });
  });
  for (const [buttonId, action] of [["mail-configuration-apply", "apply"], ["mail-configuration-check", "check"], ["mail-configuration-test", "test"]]) document.getElementById(buttonId).addEventListener("click", () => {
    const installed = newInstallationState, clientId = getStoredPreviewClientId(), context = mailConfigurationController.context();
    if (installed?.phase !== "succeeded" || installed.clientId !== clientId) return;
    const issue = action === "check" ? null : mailConfigurationController.issue(action);
    if (issue) { feedback.textContent = issue.message; deploymentWorkflow.showResult("mail"); document.getElementById(issue.id).focus(); return; }
    const settings = action === "apply" ? mailConfigurationController.values() : {};
    const recipient = action === "test" ? mailConfigurationController.recipient() : "";
    void runRemoteAction(async () => {
      try {
        await withRemoteCredentials(async (target, credentials) => {
          feedback.textContent = action === "apply" ? "Ожидается подтверждение почты уведомлений и поддержки. Для старой LMS Core один раз соберет адаптер отдельно; это может занять до 45 минут. До переключения старый сайт работает..." : action === "test" ? "Ожидается отдельное подтверждение отправки одного тестового письма..." : "Читаю настройки, наличие пароля и контакт сайта. Подключение к SMTP не выполняется...";
          const result = await launcherBridge.configureLmsMail(clientId, target, credentials, action, settings, recipient);
          if (getStoredPreviewClientId() !== clientId || mailConfigurationController.context() !== context) return;
          mailConfigurationController.receive(result, action === "apply"); deploymentWorkflow.progress("mail", result);
          feedback.textContent = result.phase === "applied" ? "Почта записана, веб-служба отвечает. Отправку можно проверить отдельной кнопкой." : result.phase === "checked" ? "Сохраненные почтовые параметры прочитаны, пароль не передается обратно в Core." : result.phase === "test_sent" ? "SMTP принял тестовое письмо. Проверьте входящие и Спам у получателя." : "Почтовая операция не подтверждена. Смотрите результат; повторную установку LMS выполнять не нужно.";
        });
      } finally { delete settings.SMTP_PASS; }
    });
  });
  for (const [id, checkOnly, https] of [["ip-publication-start", false, false], ["ip-publication-check", true, false], ["ip-publication-https", false, true]]) document.getElementById(id).addEventListener("click", () => {
    const clientId = getStoredPreviewClientId();
    if (newInstallationState?.phase !== "succeeded" || newInstallationState.clientId !== clientId) return;
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      feedback.textContent = checkOnly ? "Проверяю публикацию, HTTPS и состояние автопродления на сервере..." : https ? "Ожидается отдельное подтверждение HTTPS и условий удостоверяющего центра. После него подготовка может занять до40минут; сайт работает до переключения..." : "Проверяю установленную LMS и настраиваю Nginx. Это может занять несколько минут...";
      const result = https ? await launcherBridge.enableLmsIpHttps(clientId, target, credentials) : await launcherBridge.publishLmsIp(clientId, target, credentials, checkOnly);
      if (getStoredPreviewClientId() !== clientId) return;
      ipPublicationState = result; renderIpPublication();
      feedback.textContent = result.phase === "succeeded" ? `Адрес для обычного браузера: ${result.url}.${result.protocol === "https" ? " Автопродление выполняется на сервере." : " HTTP — только для теста."}` : "Проверьте результат публикации в панели «Ход выполнения».";
    }));
  });
  document.getElementById("ip-publication-open").addEventListener("click", () => {
    if (ipPublicationState?.phase === "succeeded" && ipPublicationState.clientId === getStoredPreviewClientId() && ipPublicationState.jobId === newInstallationState?.id && ipPublicationState.host === newInstallationState?.target.host && ipPublicationState.url === `${ipPublicationState.protocol === "https" ? "https" : "http"}://${ipPublicationState.host}`) void launcherBridge.openUrl(ipPublicationState.url).catch(() => { feedback.textContent = "Не удалось открыть браузер. Адрес указан в результате публикации."; });
  });
  const showExecutionMode = (mode) => { executionMode = mode; document.getElementById("execution-mode-select").value = mode; document.getElementById("execution-mode-caption").textContent = mode === "remote" ? "Внешние SSH-цели разрешены" : "Локальный контур"; renderNewInstallationPlan(); };
  if (launcherBridge.getExecutionMode) void launcherBridge.getExecutionMode().then(showExecutionMode).catch(() => { showExecutionMode("local"); feedback.textContent = "Не удалось прочитать режим выполнения. Внешние операции не разрешены."; });
  document.getElementById("execution-mode-select").addEventListener("change", async (event) => {
    const previous = executionMode;
    try { showExecutionMode(await launcherBridge.setExecutionMode(event.target.value)); }
    catch { showExecutionMode(previous); feedback.textContent = "Режим не изменён. Проверьте окно подтверждения и повторите попытку."; }
  });
  const syncDatabaseMode = () => { const peer = document.getElementById("install-db-mode").value === "local_peer"; for (const id of ["install-db-host", "install-db-port", "install-db-user", "install-db-password"]) document.getElementById(id).closest("label").classList.toggle("hidden", peer); renderNewInstallationPlan(); };
  document.getElementById("install-db-mode").addEventListener("change", syncDatabaseMode); syncDatabaseMode();
  const preparationProgress = (state) => { if (state.clientId !== getStoredPreviewClientId()) return; serverPreparationState = state; document.getElementById("server-preparation-result").textContent = state.message + (state.errorCode ? ` (${state.errorCode})` : ""); deploymentWorkflow.progress("environment", state); };
  launcherBridge.onPreparationProgress?.(preparationProgress);
  document.getElementById("prepare-clean-server").addEventListener("click", () => { if (!newInstallationMatches()) return; const plan = newInstallationPlan; void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => { preparationProgress(await launcherBridge.prepareCleanServer(plan.client.id, plan.id, target, credentials)); })); });
  document.getElementById("prepare-server-memory").addEventListener("click", () => {
    if (!newInstallationMatches()) return;
    const plan = newInstallationPlan, status = document.getElementById("server-memory-result");
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      status.textContent = "Ожидается подтверждение подготовки памяти в окне Core...";
      try { const result = await launcherBridge.prepareServerMemory(plan.client.id, plan.id, target, credentials); status.textContent = result.message; }
      catch (error) { status.textContent = error instanceof Error ? error.message : "Подготовка памяти не подтверждена. Проверьте результат перед повтором."; throw error; }
    }));
  });
  document.getElementById("refresh-server-preparation").addEventListener("click", () => { const id = getStoredPreviewClientId(); void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => { preparationProgress(await launcherBridge.refreshServerPreparation(id, target, credentials)); })); });
  const viewerState = (state) => {
    if (state.phase !== lmsViewerState.phase || state.clientId !== lmsViewerState.clientId || state.url !== lmsViewerState.url) lastLmsLayout = "";
    lmsViewerState = state; document.getElementById("lms-viewer-caption").textContent = state.message || "";
    document.getElementById("browser-tab-remote").classList.toggle("hidden", state.phase !== "open"); syncLmsViewerBounds();
  };
  launcherBridge.onLmsViewerState?.(viewerState);
  window.addEventListener("resize", syncLmsViewerBounds); window.addEventListener("scroll", syncLmsViewerBounds, true);
  new ResizeObserver(syncLmsViewerBounds).observe(document.getElementById("native-lms-view-host"));
  new MutationObserver(syncLmsViewerBounds).observe(previewClientModal, { attributes: true, attributeFilter: ["class"] });
  document.getElementById("browser-tab-remote").addEventListener("click", () => setBrowserMode("remote"));
  document.getElementById("close-lms-viewer").addEventListener("click", async () => { viewerState(await launcherBridge.closeLmsViewer()); setBrowserMode("preview"); });
  document.getElementById("new-installation-open-lms").addEventListener("click", async () => {
    const navigation = ++browserNavigationRevision;
    if (!await canLeaveDeployPanel() || navigation !== browserNavigationRevision) return;
    const id = getStoredPreviewClientId();
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      const state = await launcherBridge.openLmsViewer(id, target, credentials);
      if (id !== getStoredPreviewClientId()) { viewerState(await launcherBridge.closeLmsViewer()); setDiagnostics("Клиент изменился во время подключения. Предыдущий просмотр закрыт; выберите нужного клиента заново."); return; }
      viewerState(state);
      if (!await setBrowserMode("remote")) viewerState(await launcherBridge.closeLmsViewer());
    }));
  });
  launcherBridge.onInstallationProgress?.((state) => { if (state.clientId === getStoredPreviewClientId()) { newInstallationState = state; renderNewInstallationState(); renderNewInstallationPlan(); } });
  document.getElementById("new-installation-package").addEventListener("click", async () => {
    if (!await canLeaveDeployPanel()) return;
    if (!newInstallationMatches()) return;
    const plan = newInstallationPlan;
    void runRemoteAction(async () => {
      feedback.textContent = "Собираю LMS + backend и проверяю состав. Сервер не изменяется...";
      const result = await launcherBridge.prepareInstallationPackage(plan.client.id, plan.id, plan.source.snapshotId);
      if (getStoredPreviewClientId() === plan.client.id) newInstallationPlan = result;
      feedback.textContent = "Проверенный пакет готов. Далее — проверка сервера.";
    });
  });
  document.getElementById("new-installation-start").addEventListener("click", () => {
    if (!newInstallationMatches()) return;
    const plan = newInstallationPlan;
    void runRemoteAction(async () => {
      if (!installationServerCheckIsFresh(plan)) throw Error("Срок SSH-проверки истёк. На шаге «Подготовка» нажмите только «Проверить сервер». План, пакет и введённые доступы сохранены.");
      let database;
      if (document.getElementById("install-db-mode").value === "local_peer") database = { databaseMode: "local_peer" };
      else {
        const host = document.getElementById("install-db-host").value.trim(), port = Number(document.getElementById("install-db-port").value);
        if (!/^[a-z0-9][a-z0-9.-]*$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error("Проверьте хост и порт PostgreSQL.");
        const url = new URL(`postgresql://${host}:${port}/postgres`);
        url.username = document.getElementById("install-db-user").value; url.password = document.getElementById("install-db-password").value;
        if (!["127.0.0.1", "localhost"].includes(host)) url.searchParams.set("sslmode", "verify-full");
        database = { maintenanceUrl: url.href };
      }
      const secrets = { ...database, clientAdminLogin: document.getElementById("install-client-login").value.trim(), clientAdminName: document.getElementById("install-client-name").value.trim(),
        clientAdminPassword: document.getElementById("install-client-password").value, systemAdminLogin: document.getElementById("install-system-login").value.trim(), systemAdminPassword: document.getElementById("install-system-password").value };
      const saved = installationAccessClient === plan.client.id ? installationAccessState : null;
      secrets.useSavedAccess = Boolean(saved?.revision);
      const issue = window.coreDeploymentWorkflow.adminIssue({ ...secrets,
        clientAdminPassword: secrets.clientAdminPassword || (saved?.saved?.clientAdminPassword && secrets.clientAdminLogin === saved.values.clientAdminLogin ? "saved-secret-present" : ""),
        systemAdminPassword: secrets.systemAdminPassword || (saved?.saved?.systemAdminPassword && secrets.systemAdminLogin === saved.values.systemAdminLogin ? "saved-secret-present" : "") });
      if (issue) {
        secrets.maintenanceUrl = ""; secrets.clientAdminPassword = ""; secrets.systemAdminPassword = "";
        deploymentWorkflow.select("installation");
        document.getElementById("new-installation-credentials").open = true;
        // runRemoteAction temporarily disables controls; restore focus after its finally block.
        setTimeout(() => document.getElementById(issue.id)?.focus(), 0);
        throw Error(issue.message);
      }
      for (const id of ["install-db-password", "install-client-password", "install-system-password"]) document.getElementById(id).value = "";
      try { await withRemoteCredentials(async (target, credentials) => {
        const state = await launcherBridge.startInstallation(plan.client.id, plan.id, plan.source.snapshotId, target, credentials, secrets);
        if (getStoredPreviewClientId() === plan.client.id) { newInstallationState = state; renderNewInstallationState(); }
      }); } finally { secrets.maintenanceUrl = ""; secrets.clientAdminPassword = ""; secrets.systemAdminPassword = ""; }
    });
  });
  document.getElementById("new-installation-refresh").addEventListener("click", () => {
    const id = getStoredPreviewClientId();
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      const state = await launcherBridge.refreshInstallation(id, target, credentials);
      if (getStoredPreviewClientId() === id) { newInstallationState = state; renderNewInstallationState(); }
    }));
  });
  document.getElementById("remote-operation-mode").addEventListener("change", updateRemoteOperationMode);
  for (const id of ["remote-host", "remote-port", "remote-username", "remote-base-path", "remote-fingerprint"]) document.getElementById(id).addEventListener("input", renderNewInstallationPlan);
  document.getElementById("new-installation-content-mode").addEventListener("change", renderNewInstallationPlan);
  document.getElementById("new-installation-prepare").addEventListener("click", () => {
    const clientId = getStoredPreviewClientId();
    const snapshot = sourceState?.snapshot;
    const source = readRepositoryForm();
    if (!clientId || repositoryTargetClientId !== clientId) { feedback.textContent = "Сначала выберите клиента с доступной карточкой Core."; return; }
    if (sourceState?.phase !== "ready" || !snapshot || snapshot.repositoryUrl !== source.url.trim() || snapshot.requestedBranch !== source.branch.trim()) { feedback.textContent = "Получите код текущего репозитория и ветки перед подготовкой."; return; }
    const contentMode = document.getElementById("new-installation-content-mode").value;
    if (!["empty", "source"].includes(contentMode)) { feedback.textContent = "Выберите наполнение: темы и тесты из Git или пустая учебная база."; return; }
    void runRemoteAction(async () => {
      feedback.textContent = "Связываю клиента, Git-версию, автоматический путь и параметры БД. Это локальная подготовка без SSH...";
      const plan = await launcherBridge.prepareInstallation(clientId, snapshot.id, readRemoteTarget(), contentMode);
      if (getStoredPreviewClientId() !== clientId) return;
      newInstallationPlan = plan;
      renderNewInstallationPlan();
      feedback.textContent = "План сохранён. Условия установки показаны в панели «Ход выполнения»; каталоги и процессы сервера не менялись.";
    });
  });
  document.getElementById("new-installation-server-check").addEventListener("click", () => {
    if (!newInstallationMatches()) { feedback.textContent = "План устарел. Подготовьте его заново."; return; }
    const plan = newInstallationPlan;
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      feedback.textContent = "Проверяю новый путь, инструменты, ресурсы и свободный порт. Сервер не изменяется...";
      const checked = await launcherBridge.checkInstallationServer(plan.client.id, plan.id, plan.source.snapshotId, target, credentials);
      if (getStoredPreviewClientId() !== plan.client.id) return;
      newInstallationPlan = checked;
      renderNewInstallationPlan();
      feedback.textContent = "SSH-проверка новой установки завершена. Каталоги не создавались; запуск пока не выполнен.";
    }));
  });
  const clearConnectionProof = () => {
    clearRemoteCredentials();
    document.getElementById("remote-fingerprint").value = "";
    serverAccess?.changed();
    document.getElementById("remote-candidate").textContent = "Адрес/порт изменены. Отпечаток нужно получить и сверить заново.";
    document.getElementById("remote-inventory").textContent = "";
    document.getElementById("remote-preflight-result").textContent = "";
    document.getElementById("remote-allow-swap").checked = false;
    syncDeploymentWorkflow();
  };
  document.getElementById("remote-host").addEventListener("input", clearConnectionProof);
  document.getElementById("remote-port").addEventListener("input", clearConnectionProof);
  for (const id of ["remote-username", "remote-base-path", "remote-app-path", "remote-fingerprint"]) document.getElementById(id).addEventListener("input", () => { clearRemoteCredentials(); serverAccess?.changed(); });
  document.getElementById("remote-fingerprint").addEventListener("input", () => {
    if (document.getElementById("remote-fingerprint").value.trim()) document.getElementById("remote-candidate").textContent = "Отпечаток введен вручную. Сохраните SSH-параметры только после независимой сверки через консоль хостера.";
  });
  document.getElementById("remote-clear-credentials").addEventListener("click", () => { clearRemoteCredentials(); feedback.textContent = "SSH-пароль и пароль ключа очищены из текущего окна."; });
  window.addEventListener("pagehide", clearRemoteCredentials);
  document.getElementById("remote-app-path").addEventListener("input", () => { document.getElementById("remote-preflight-result").textContent = ""; });
  document.getElementById("remote-auth-mode").addEventListener("change", () => {
    const key = document.getElementById("remote-auth-mode").value === "key";
    document.getElementById("remote-password-row").classList.toggle("hidden", key);
    document.getElementById("remote-key-row").classList.toggle("hidden", !key);
    clearRemoteCredentials();
    serverAccess?.refresh();
  });
  document.getElementById("remote-save-button").addEventListener("click", () => { void runRemoteAction(async () => {
    if (serverAccess) await serverAccess.saveTarget();
    else await launcherBridge.saveRemoteTarget(readRemoteTarget());
    feedback.textContent = "Сервер сохранён за выбранным клиентом. Чтобы сохранить пароль, нажмите замок в его поле. Соединение ещё не проверено.";
  }); });
  document.getElementById("remote-probe-button").addEventListener("click", () => { void runRemoteAction(async () => {
    feedback.textContent = "Получаю публичный ключ сервера без отправки пароля...";
    const result = await launcherBridge.probeRemoteTarget(readRemoteTarget());
    document.getElementById("remote-candidate").textContent = `Получен из сети: ${result.fingerprint}\nСверьте это значение через консоль хостера перед SSH-входом.`;
    feedback.textContent = "Отпечаток получен, но пока не считается подтверждённым.";
  }); });
  document.getElementById("remote-choose-key").addEventListener("click", () => { void runRemoteAction(async () => {
    const file = await launcherBridge.chooseRepositoryKey();
    if (file && document.getElementById("remote-identity-file").value !== file) { clearRemoteCredentials(); document.getElementById("remote-identity-file").value = file; }
  }); });
  document.getElementById("remote-target-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const pane = document.querySelector("[data-deploy-pane]:not(.hidden)")?.dataset.deployPane;
    if (document.getElementById("remote-operation-mode").value === "new" || pane !== "preparation" || event.submitter?.id !== "remote-inspect-button") {
      feedback.textContent = "Выберите отдельную кнопку нужного действия. Enter не запускает установку и не пересоздает план.";
      return;
    }
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      document.getElementById("remote-inventory").textContent = "";
      feedback.textContent = "Проверяю вход и читаю сведения об установке. Сервер не изменяется...";
      const result = await launcherBridge.inspectRemoteTarget(target, credentials);
      renderRemoteInventory(result);
      feedback.textContent = "SSH-вход подтверждён. Сведения прочитаны; сайт и БД не изменялись.";
    }));
  });
  document.getElementById("remote-preflight-button").addEventListener("click", () => {
    if (!readRemoteTarget().appPath.trim()) { feedback.textContent = "Укажите каталог существующей LMS для предварительной проверки."; return; }
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      document.getElementById("remote-preflight-result").textContent = "";
      feedback.textContent = "Проверяю режим данных, управляющий процесс и состав будущего backup. Установка не меняется...";
      const result = await launcherBridge.preflightRemoteTarget(target, credentials, getStoredPreviewClientId());
      renderRemotePreflight(result);
      feedback.textContent = "Предварительная проверка завершена. Backup, сборка и переключение сайта не выполнялись.";
    }));
  });
  document.getElementById("remote-deploy-button").addEventListener("click", () => {
    const snapshot = sourceState?.snapshot;
    if (sourceState?.phase !== "ready" || !snapshot) { feedback.textContent = "Сначала получите код выбранного репозитория кнопкой «Получить код»."; return; }
    const form = readRepositoryForm();
    if (snapshot.repositoryUrl !== form.url.trim() || snapshot.requestedBranch !== form.branch.trim()) { feedback.textContent = "Источник или ветка изменены. Получите код заново перед обновлением."; return; }
    const allowSwap = document.getElementById("remote-allow-swap").checked;
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      feedback.textContent = "Ожидается подтверждение обновления в окне приложения.";
      const result = await launcherBridge.deployRemoteTarget(target, credentials, snapshot.id, allowSwap, getStoredPreviewClientId());
      renderDeploymentState(result);
      feedback.textContent = result.message;
    }));
  });
  document.getElementById("remote-deployment-refresh").addEventListener("click", () => {
    void runRemoteAction(() => withRemoteCredentials(async (target, credentials) => {
      feedback.textContent = "Читаю состояние серверной задачи без повторного запуска...";
      const result = await launcherBridge.refreshDeployment(target, credentials, getStoredPreviewClientId());
      renderDeploymentState(result);
      feedback.textContent = result.message;
    }));
  });
  updateRemoteOperationMode();
}

async function loadRepositoryTarget() {
  const request = ++repositoryTargetRequest;
  const clientId = getStoredPreviewClientId();
  if (installationAccessClient !== clientId) {
    installationAccessState = null; installationAccessClient = clientId;
    for (const id of ["install-client-name", "install-client-login", "install-client-password", "install-system-login", "install-system-password", "install-db-host", "install-db-user", "install-db-password"]) document.getElementById(id).value = "";
    document.getElementById("install-db-host").value = "127.0.0.1";
    document.getElementById("install-db-user").value = "postgres";
    document.getElementById("install-db-port").value = "5432";
  }
  deploymentWorkflow?.setContext(clientId);
  repositoryTargetClientId = "";
  repositoryClientSlug = "";
  newInstallationPlan = null;
  ++newInstallationRequest;
  renderNewInstallationPlan();
  const feedback = document.getElementById("repository-target-feedback");
  const configure = document.getElementById("repository-configure-target");
  const refresh = document.getElementById("repository-refresh-target");
  const client = document.getElementById("repository-target-client");
  const host = document.getElementById("repository-target-host");
  const directory = document.getElementById("repository-target-path");
  const database = document.getElementById("repository-target-database");
  configure.disabled = true;
  refresh.disabled = !clientId;
  client.textContent = "Не выбран";
  host.textContent = "Не задан";
  directory.textContent = "Не задана";
  database.textContent = "Не задан";
  if (!clientId) {
    feedback.textContent = "Выберите клиента, чтобы увидеть настройки его серверов.";
    return;
  }
  feedback.textContent = "Загружаю сохранённый профиль клиента...";
  client.textContent = getStoredPreviewClientName() || "Загрузка...";
  refresh.disabled = true;
  try {
    const detail = await launcherBridge.fetchJson(`http://127.0.0.1:3001/api/deploy-panel/client-detail?clientId=${encodeURIComponent(clientId)}`);
    // Ignore an older request if another client was selected before it finished.
    if (request !== repositoryTargetRequest || clientId !== getStoredPreviewClientId()) return;
    if (!detail?.client || detail.client.id !== clientId) throw new Error("API вернул профиль другого клиента или неполный ответ.");
    await serverAccess?.ensureLoaded();
    if (request !== repositoryTargetRequest || clientId !== getStoredPreviewClientId()) return;
    repositoryTargetClientId = clientId;
    repositoryClientSlug = detail.client.slug || "";
    client.textContent = detail.client.name;
    configure.disabled = false;
    const profile = detail.profile;
    host.textContent = profile?.hostUrl || "Не задан";
    directory.textContent = profile?.deployPath || "Не задана";
    database.textContent = profile?.databaseHost ? `${profile.databaseHost}:${profile.databasePort || 5432}${profile.databaseName ? ` / ${profile.databaseName}` : ""}` : "Не задан";
    if (launcherBridge.installationAccessRequest) {
      const previous = installationAccessState;
      const access = await launcherBridge.installationAccessRequest("get", clientId);
      if (request !== repositoryTargetRequest || clientId !== getStoredPreviewClientId()) return;
      installationAccessState = access;
      for (const [id, key] of [["install-client-name", "clientAdminName"], ["install-client-login", "clientAdminLogin"], ["install-system-login", "systemAdminLogin"], ["install-db-host", "databaseHost"], ["install-db-port", "databasePort"], ["install-db-user", "databaseUser"]]) {
        const field = document.getElementById(id);
        if (!field.value || !previous || String(previous.values?.[key] ?? "") === field.value) field.value = access.values?.[key] ?? "";
      }
      if (!previous || document.getElementById("install-db-mode").value === (previous.values?.databaseMode === "manual" ? "password" : "local_peer")) document.getElementById("install-db-mode").value = access.values.databaseMode === "manual" ? "password" : "local_peer";
      document.getElementById("install-db-mode").dispatchEvent(new Event("change"));
      for (const [id, key] of [["install-client-password", "clientAdminPassword"], ["install-system-password", "systemAdminPassword"], ["install-db-password", "databasePassword"]]) document.getElementById(id).placeholder = access.saved?.[key] ? "Сохранён в карточке — повторять не нужно" : "Не сохранён: задайте в карточке клиента";
      document.getElementById("installation-access-note").textContent = access.saved?.clientAdminPassword && access.saved?.systemAdminPassword ? "Доступы взяты из карточки клиента. Пароли подставляются защищённо при запуске — вводить повторно не нужно." : "Сохраните пароли в блоке «Пароли и доступы» карточки клиента. Старые хеши нельзя восстановить; их нужно задать один раз.";
    }
    feedback.textContent = profile ? "Настройки из карточки клиента. Доступность удалённых серверов здесь не проверялась." : "У клиента пока нет профиля развёртывания.";
    void loadNewInstallationPlan();
  } catch (error) {
    if (request !== repositoryTargetRequest) return;
    feedback.textContent = `Не удалось загрузить профиль: ${error instanceof Error ? error.message : String(error)}. Проверьте локальный API и повторите обновление.`;
  } finally {
    if (request === repositoryTargetRequest) refresh.disabled = false;
  }
}

function bindRepositoryControls() {
  const markDirty = () => {
    updateRepositoryIdentity();
    repositoryFeedback("Параметры изменены. Нажмите «Сохранить и проверить». Ниже остается результат предыдущей проверки.");
    if (sourceState) renderSourceState(sourceState);
  };
  document.getElementById("repository-choose-client").addEventListener("click", () => { void choosePreviewClient("repository"); });
  document.getElementById("repository-refresh-target").addEventListener("click", () => { void loadRepositoryTarget(); });
  document.getElementById("repository-configure-target").addEventListener("click", () => {
    if (repositoryTargetClientId && repositoryTargetClientId === getStoredPreviewClientId()) setBrowserMode("deploy");
  });
  document.getElementById("source-fetch-button").addEventListener("click", async () => {
    if (repositoryBusy || !document.getElementById("repository-form").reportValidity()) return;
    sourceIsWorking = true;
    setRepositoryBusy(true);
    renderSourceState({ phase: "working", message: "Проверяю источник перед получением кода...", snapshot: sourceState?.snapshot || null });
    try {
      const result = await launcherBridge.fetchSource(readRepositoryForm());
      showRepositoryState(result.repository);
      renderSourceState(result.source);
    } catch (error) {
      renderSourceState({ phase: "failed", message: `Получение кода не завершено: ${error instanceof Error ? error.message : String(error)}`, snapshot: sourceState?.snapshot || null });
      await loadRepositoryState();
    } finally {
      sourceIsWorking = false;
      setRepositoryBusy(false);
    }
  });
  document.getElementById("repository-form").addEventListener("input", markDirty);
  document.getElementById("repository-identity-mode").addEventListener("change", markDirty);
  document.getElementById("repository-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (repositoryBusy) return;
    const config = readRepositoryForm();
    setRepositoryBusy(true);
    repositoryFeedback("Core проверяет SSH-хост, доступ к репозиторию и выбранную ветку. Код не изменяется.");
    try {
      showRepositoryState(await launcherBridge.checkRepository(config));
    } catch (error) {
      repositoryFeedback(`Проверка не завершена: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setRepositoryBusy(false);
    }
  });
  document.getElementById("repository-choose-key").addEventListener("click", async () => {
    try {
      const file = await launcherBridge.chooseRepositoryKey();
      if (file) {
        document.getElementById("repository-identity-file").value = file;
        markDirty();
      }
    } catch (error) {
      repositoryFeedback(`Файл ключа не выбран: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });
  document.getElementById("repository-create-key").addEventListener("click", async () => {
    if (repositoryBusy) return;
    setRepositoryBusy(true);
    document.getElementById("repository-check").textContent = "Подготовка ключа...";
    try {
      const key = await launcherBridge.createRepositoryKey();
      if (!key) { repositoryFeedback("Создание ключа отменено."); return; }
      repositoryState = { ...repositoryState, key };
      renderRepositoryKey(key);
      document.getElementById("repository-identity-mode").value = "managed";
      updateRepositoryIdentity();
      document.getElementById("repository-key-details").open = true;
      repositoryFeedback("Ключ Core подготовлен. Добавьте его публичную часть в Deploy keys репозитория без права записи, затем проверьте доступ.");
    } catch (error) {
      repositoryFeedback(`Не удалось создать ключ: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setRepositoryBusy(false);
    }
  });
  document.getElementById("repository-copy-public-key").addEventListener("click", async () => {
    try {
      await launcherBridge.copyRepositoryPublicKey();
      repositoryFeedback("Публичный ключ скопирован. Вставьте его в GitHub Deploy keys; «Allow write access» не включайте.");
    } catch (error) {
      repositoryFeedback(`Копирование не выполнено: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });
  document.getElementById("repository-github-settings").addEventListener("click", async () => {
    try {
      await launcherBridge.openRepositoryGitHubSettings(readRepositoryForm());
    } catch (error) {
      repositoryFeedback(error instanceof Error ? error.message : String(error), "error");
    }
  });
}

function bindDatabaseControls() {
  refreshDatabaseButton?.addEventListener("click", () => {
    setButtonPressed(refreshDatabaseButton);
    void loadPostgresSnapshot(activeDatabaseTable);
  });

  openDatabasePgAdminButton?.addEventListener("click", async () => {
    setButtonPressed(openDatabasePgAdminButton);
    await launcherBridge.openPgAdmin();
  });
}

function bindModal() {
  closePreviewClientModalButton?.addEventListener("click", () => {
    setButtonPressed(closePreviewClientModalButton);
    closePreviewClientModal();
  });

  previewClientSearchInput?.addEventListener("input", (event) => {
    renderPreviewClientList(event.target.value);
  });

  previewClientModal?.addEventListener("click", (event) => {
    if (event.target === previewClientModal) {
      closePreviewClientModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !previewClientModal?.classList.contains("hidden")) {
      closePreviewClientModal();
      return;
    }

    if (event.key === "Escape" && isBrowserFocusMode) {
      setBrowserFocusMode(false);
    }
  });
}

function bindGlobalActions() {
  document.getElementById("log-scroll-bottom").addEventListener("click", () => {
    if (hasLogSelection()) window.getSelection()?.removeAllRanges();
    logPanelContent.scrollTop = logPanelContent.scrollHeight;
    logSelectionPaused = false;
    void refreshActiveLog({ force: true }).catch((error) => setDiagnostics(`Не удалось прочитать журнал: ${error instanceof Error ? error.message : String(error)}`));
  });
  document.addEventListener("selectionchange", () => {
    if (logSelectionPaused && !hasLogSelection() && activeView === "logs") {
      logSelectionPaused = false;
      void refreshActiveLog().catch((error) => setDiagnostics(`Не удалось прочитать журнал: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  document.getElementById("refresh-button")?.addEventListener("click", async () => {
    setButtonPressed(document.getElementById("refresh-button"));

    try {
      setDiagnostics("Обновляю статусы...");
      await refreshStatuses({ fresh: true });
      await refreshActiveLog({ force: true });
      setDiagnostics("Статусы обновлены.");
    } catch (error) {
      setDiagnostics(`Ошибка обновления: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  document.getElementById("open-config-button")?.addEventListener("click", async () => {
    setButtonPressed(document.getElementById("open-config-button"));
    try {
      const opened = await launcherBridge.openConfig();
      if (!opened) {
        throw new Error("Не удалось открыть файл конфигурации.");
      }
    } catch (error) {
      setDiagnostics(`Ошибка открытия конфигурации: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  document.getElementById("open-launcher-log-button")?.addEventListener("click", async () => {
    setButtonPressed(document.getElementById("open-launcher-log-button"));

    if (launcherLogPath) {
      await launcherBridge.openFile(launcherLogPath);
      await showLog(launcherLogPath, "Системный лог launcher");
    }
  });

  openLogViewLauncherButton?.addEventListener("click", async () => {
    setButtonPressed(openLogViewLauncherButton);

    if (launcherLogPath) {
      await showLog(launcherLogPath, "Системный лог launcher");
    }
  });

  document.getElementById("start-all-button")?.addEventListener("click", async () => {
    const button = document.getElementById("start-all-button");
    setButtonPressed(button);
    if (lastStatuses.length && lastStatuses.every((status) => status.healthState === "healthy" && !["starting", "stopping"].includes(status.state))) {
      setBrowserMode("deploy");
      return;
    }
    setButtonWorking(button, true);
    button.textContent = "Запускаю ядро...";

    try {
      setBusy(true);
      summaryText.textContent = "Запускаю все сервисы...";
      const results = await launcherBridge.startAll();
      await refreshStatuses({ fresh: true });
      const failed = results.filter((status) => status.ok === false || status.healthState !== "healthy");
      setDiagnostics(failed.length ? `Не запущено: ${failed.map((status) => `${status.label}: ${status.message}`).join("; ")}` : "Все локальные сервисы прошли проверки.");
      if (!failed.length) setBrowserMode("deploy");
    } catch (error) {
      setDiagnostics(`Ошибка запуска всех сервисов: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setButtonWorking(button, false);
      setBusy(false);
      updateOverview(lastStatuses);
    }
  });

  document.getElementById("stop-all-button")?.addEventListener("click", async () => {
    const button = document.getElementById("stop-all-button");
    setButtonPressed(button);
    setButtonWorking(button, true);

    try {
      setBusy(true);
      summaryText.textContent = "Останавливаю все сервисы...";
      const results = await launcherBridge.stopAll();
      await refreshStatuses();
      const failed = results.filter((status) => status.ok === false || status.running);
      setDiagnostics(failed.length ? `Не остановлено: ${failed.map((status) => `${status.label}: ${status.message}`).join("; ")}` : "Порты всех сервисов закрыты.");
    } catch (error) {
      setDiagnostics(`Ошибка остановки всех сервисов: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setButtonWorking(button, false);
      setBusy(false);
    }
  });
}

async function bootstrap() {
  if (!launcherBridge) {
    summaryText.textContent = "Launcher API не найден";
    setDiagnostics("Ошибка: preload не подключился.");
    return;
  }

  // Visibility, addresses and appearance do not depend on each other; keep each read's fallback independent.
  await Promise.all([
    bindWindowVisibility(),
    (async () => {
      try {
        const config = await launcherBridge.getConfig?.();
        localServices = Array.isArray(config?.services) ? config.services : [];
      } catch {
        setDiagnostics("Не удалось прочитать адреса локальных сервисов. Проверьте конфигурацию.");
      }
    })(),
    (async () => {
      try {
        if (launcherBridge.getInterfacePreferences) {
          const result = await launcherBridge.getInterfacePreferences(currentPreferences);
          currentPreferences = window.corePreferences.normalize(result.preferences);
          cachePreferences(currentPreferences);
          settingsSaveStatus(result.warning || "Сохранено на этом компьютере", Boolean(result.warning));
        } else settingsSaveStatus("Настройки этого окна");
      } catch {
        settingsSaveStatus("Профиль Windows недоступен. Использована локальная копия настроек.", true);
      }
    })()
  ]);
  syncSettingsUi();
  bindNavigation();
  bindSettings();
  bindBrowserControls();
  bindGitPreview();
  bindDatabaseControls();
  bindModal();
  bindGlobalActions();
  bindRepositoryControls();
  sourceLibraryController = window.coreSourceLibrary.create({ bridge: launcherBridge, repository: () => repositoryState,
    open: async (source) => {
      if (repositoryBusy || sourceIsWorking || remoteBusy) throw Error("Дождитесь завершения текущей операции.");
      if (!await canLeaveDeployPanel()) return;
      setActiveView("repository");
      if (activeView !== "repository") return;
      document.getElementById("repository-url").value = source.url;
      document.getElementById("repository-branch").value = source.branch;
      repositoryFeedback(`Открыт источник «${source.name}». Для подключения нажмите «Сохранить и проверить».`, "neutral");
      if (sourceState) renderSourceState(sourceState);
      document.getElementById("repository-url").focus();
    }
  });
  void sourceLibraryController.load();
  bindRemoteControls();
  void loadRepositoryState();
  void loadSourceState();
  void loadRemoteTarget();
  launcherBridge.onDeploymentProgress?.((state) => {
    renderDeploymentState(state);
    // The confirmation prompt must not remain visible once the real job reports progress.
    document.getElementById("remote-feedback").textContent = state.message;
  });
  launcherBridge.onSourceProgress?.((state) => {
    renderSourceState(state);
    if (state.phase === "working") { sourceIsWorking = true; setRepositoryBusy(true); }
    else if (sourceIsWorking) { sourceIsWorking = false; setRepositoryBusy(false); }
  });
  launcherBridge.onOperationProgress?.((message) => {
    setDiagnostics(message);
    void refreshStatuses().catch((error) => {
      setDiagnostics(`Не удалось обновить статусы: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  if (browserClientIdInput) {
    browserClientIdInput.value = getStoredPreviewClientId();
  }

  updatePreviewClientCaption();
  activeBrowserMode = "deploy";
  browserTabDeploy?.classList.add("is-current");
  browserTabPreview?.classList.remove("is-current");
  if (browserAddressInput) {
    browserAddressInput.value = buildBrowserUrl("deploy");
  }
  updateEmbeddedCaption("deploy");
  setBrowserFocusMode(false);

  const initialView = getCurrentPreferences().defaultView || "overview";
  if (initialView === "lms") await setBrowserMode("preview");
  else setActiveView(initialView);

  try {
    const [ping, logPath] = await Promise.all([launcherBridge.ping(), launcherBridge.getLauncherLogPath()]);
    launcherLogPath = logPath;
    await refreshStatuses();
    setDiagnostics("Центр управления подключен.");

    if (launcherLogPath && !activeLogPath) {
      // Do not block app readiness on a log that is not open, or overwrite a user's newer file choice.
      selectLogPath(launcherLogPath, "Журнал приложения");
      if (activeView === "logs") void refreshActiveLog().catch((error) => setDiagnostics(`Не удалось прочитать журнал: ${error instanceof Error ? error.message : String(error)}`));
    }

    if (initialView === "database") {
      await loadPostgresSnapshot();
    }
  } catch (error) {
    summaryText.textContent = "Ошибка инициализации";
    setDiagnostics(`Не удалось инициализировать launcher: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  document.body.dataset.launcherReady = "true";

  configurePolling();
}

embeddedPanelFrame?.addEventListener("load", () => {
  syncDeployAppearance();
  if (["deploy", "preview"].includes(activeBrowserMode) && embeddedPanelFrame.src !== "about:blank") {
    panelSelection.begin(pendingPanelClientId ?? ""); pendingPanelClientId = null;
    syncPanelClientContext();
  }
});
window.addEventListener("message", receivePanelClientSelection);
const accessPanelRequests = new Set();
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (data?.type !== "lms-core:installation-access" || data.version !== 1 || event.source !== embeddedPanelFrame?.contentWindow || activeBrowserMode !== "deploy" || document.body.dataset.clientDeleting === "true") return;
  let origin;
  try { origin = new URL(buildBrowserUrl("deploy")).origin; } catch { return; }
  const context = panelSelection.envelope();
  if (event.origin !== origin || !context || data.session !== context.session || !/^[a-f0-9-]{36}$/.test(data.requestId || "") || !/^[a-f0-9-]{36}$/.test(data.clientId || "") || !["get", "save", "capture"].includes(data.action) || accessPanelRequests.has(data.requestId)) return;
  accessPanelRequests.add(data.requestId); if (accessPanelRequests.size > 200) accessPanelRequests.delete(accessPanelRequests.values().next().value);
  let result;
  try {
    if (!launcherBridge.installationAccessRequest) throw Error("Перезапустите Core для загрузки защищенного хранилища доступов.");
    result = { ok: true, value: await launcherBridge.installationAccessRequest(data.action, data.clientId, data.values, data.revision) };
  } catch (error) { result = { ok: false, error: error instanceof Error ? error.message.slice(0, 600) : "Core не подтвердил сохранение доступов." }; }
  if (panelSelection.envelope()?.session === data.session && event.source === embeddedPanelFrame?.contentWindow) event.source.postMessage({ type: "lms-core:installation-access-result", version: 1, requestId: data.requestId, session: data.session, ...result }, origin);
});
window.addEventListener("message", (event) => {
  const pending = pendingPanelState;
  if (!pending || !["deploy", "preview"].includes(activeBrowserMode)) return;
  try {
    const state = panelSelection.acceptState(event, embeddedPanelFrame.contentWindow, new URL(buildBrowserUrl(activeBrowserMode)).origin, pending.requestId);
    if (state) pending.finish(state);
  } catch { /* Ignore messages outside the current local panel session. */ }
});
window.addEventListener("message", (event) => {
  if (event.source !== embeddedPanelFrame?.contentWindow || event.data?.type !== "lms-core:client-context-ready" || event.data?.version !== 1) return;
  try { if (["deploy", "preview"].includes(activeBrowserMode) && event.origin === new URL(buildBrowserUrl(activeBrowserMode)).origin) syncPanelClientContext(); } catch { /* Not the configured workspace. */ }
});
window.addEventListener("message", (event) => {
  if (event.source !== embeddedPanelFrame?.contentWindow || event.data?.type !== "lms-core:appearance-ready") return;
  try {
    if (event.origin === new URL(buildBrowserUrl("deploy")).origin) {
      deployAppearanceReady = true;
      syncDeployAppearance();
    }
  } catch { /* No configured local panel. */ }
});
syncSettingsUi();
void bootstrap();
