import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
import { runJsonCommand } from "./command-json";
import { checkHttpHealth, checkLocalPage, checkPostgresHealth, HealthCheck } from "./service-health";
import { normalizeRepositoryConfig, RepositoryService } from "./repository";
import { SourceSnapshotService } from "./source-snapshots";
import { SourceLibraryStore } from "./source-library";
import { ClientServerStore } from "./client-servers";
import { ClientInstallationAccessStore, InstallationAccess } from "./client-installation-access";
import { accessProfilePayload } from "./client-access-profile";
import { UninstallationService } from "./uninstallation";
import { FullUninstallationService } from "./full-uninstallation";
import { ClientDeletionService } from "./client-deletion";
import { normalizeRemoteTarget, RemoteTargetService } from "./remote-target";
import { DeploymentPackageService } from "./deployment-package";
import { RemoteDeploymentService } from "./remote-deployment";
import { ManagedUpdateService, resolveManagedUpdateTarget } from "./managed-update";
import { NewInstallationService } from "./new-installation";
import { InstallationPackageService } from "./installation-package";
import { installationClient } from "./installation-client";
import { AutomaticSourcePreparation } from "./automatic-source-preparation";
import { assertNewInstallationReady, NewDeploymentService } from "./new-deployment";
import { LmsViewerService } from "./lms-viewer";
import { IpPublicationService } from "./ip-publication";
import { AiConfigurationService, normalizeAiInput, normalizeAiProvisionInput } from "./ai-configuration";
import { MailAction, MailConfigurationService } from "./mail-configuration";
import { prepareSupportPatch } from "./support-contact-adapter";
import { NativeLmsView } from "./native-lms-view";
import { ServerPreparationService } from "./server-preparation";
import { ExecutionPolicy } from "./execution-policy";
import { PageReadinessCache } from "./page-readiness-cache";
import { InterfacePreferencesStore } from "./interface-preferences";
import { themes, InterfacePreferences } from "../renderer/preferences";
import { localPreviewQuery, readPostgresSnapshot } from "./postgres-preview";
import { LogTailReader } from "./log-tail";
import { createRefreshQueue } from "../renderer/refresh-queue";
import { confirmPreventedUnload } from "./unload-confirmation";
import { ClientDesignService } from "./client-design";
import { LocalGitPreviewService } from "./local-git-preview";
import { PointDesignService, PointEditor } from "./point-design";

const execFileAsync = promisify(execFile);

type LauncherService = {
  id: string;
  label: string;
  kind: string;
  port: number;
  url: string;
  command?: string;
  logFile?: string;
  environment?: Record<string, string>;
};

type LauncherConfig = {
  workspaceRoot: string;
  environment?: Record<string, string>;
  services: LauncherService[];
};

type ServiceStatus = {
  id: string;
  label: string;
  kind: string;
  port: number;
  url: string;
  logFile: string | null;
  errorLogFile: string | null;
  pidFile: string | null;
  running: boolean;
  portOpen: boolean;
  pid: number | null;
  ok?: boolean;
  healthState?: HealthCheck["healthState"];
  state?: "starting" | "stopping" | HealthCheck["healthState"];
  checkedAt?: string;
  responseTimeMs?: number;
  message: string;
};

const projectRoot = path.resolve(__dirname, "../../..");
const controlScriptPath = path.join(projectRoot, "infra", "scripts", "control-dev-service.ps1");
const configPath = path.join(projectRoot, "apps", "control-center", "config", "launcher-config.json");
const launcherLogPath = path.join(projectRoot, "infra", "runtime", "logs", "control-center.log");
const psqlPath = process.env.CORE_PG_BIN ? path.join(process.env.CORE_PG_BIN, "psql.exe") : "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const repositoryService = new RepositoryService(projectRoot, {
  git: process.env.CORE_GIT_PATH || path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe"),
  ssh: process.env.CORE_SSH_PATH || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe"),
  keygen: process.env.CORE_KEYGEN_PATH || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh-keygen.exe")
}, {
  // Never fall back to plain-text storage when the OS key store is unavailable.
  available: () => safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (encrypted) => safeStorage.decryptString(encrypted)
});
const sourceSnapshots = new SourceSnapshotService(projectRoot, repositoryService,
  path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"));
const clientServers = new ClientServerStore(path.join(app.getPath("userData"), "client-servers"), {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value)
});
const installationAccess = new ClientInstallationAccessStore(path.join(app.getPath("userData"), "installation-access"), {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value)
});
const remoteTarget = new RemoteTargetService(projectRoot, undefined, async (target, auth) => {
  if (auth.savedForClient && !(await clientServers.get(auth.savedForClient, target)).passwordSaved) return installationAccess.sshCredentials(target, auth);
  return clientServers.credentials(target, auth);
});
const deploymentPackages = new DeploymentPackageService(projectRoot, sourceSnapshots,
  process.env.CORE_GIT_PATH || path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe"),
  path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"));
const remoteDeployment = new RemoteDeploymentService(projectRoot, remoteTarget, deploymentPackages);
const loadInstallationClient = async (clientId: string): Promise<{ client: Record<string, unknown>; profile?: Record<string, any>; adminCredentials?: Record<string, any> }> => {
  // Read from the configured local Core API, never a renderer-provided URL or a remote demo host.
  try {
    const config = await readLauncherConfig();
    const api = config.services.find((service) => service.id === "api");
    if (!api || !Number.isInteger(api.port) || api.port < 1 || api.port > 65535) throw new Error("API unavailable");
    const origin = `http://127.0.0.1:${api.port}`;
    if ((await checkHttpHealth(`${origin}/api/health`, "lms-core-api")).healthState !== "healthy") throw new Error("API identity unconfirmed");
    const response = await fetch(`${origin}/api/deploy-panel/client-detail?clientId=${encodeURIComponent(clientId)}`, { redirect: "error", signal: AbortSignal.timeout(7000) });
    if (!response.ok) throw new Error("Client unavailable");
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Oversized API response");
    const value = JSON.parse(text);
    if (!value?.client || value.client.id !== clientId || typeof value.client !== "object" || Array.isArray(value.client)) throw new Error("Client card unavailable");
    return value;
  } catch { throw new Error("Не удалось прочитать карточку клиента из локального Core API. Проверьте сервис и выбранного клиента."); }
};
const accessSaves = new Set<string>();
async function installationAccessMetadata(clientId: string) {
  const detail = await loadInstallationClient(clientId), stored = await installationAccess.get(clientId);
  const admin = detail.adminCredentials || {}, profile = detail.profile || {};
  let host = "";
  try { host = new URL(String(profile.hostUrl || `http://${detail.client.domain}`)).hostname; } catch { /* An incomplete card may not have a server yet. */ }
  const values = { clientAdminName: String(admin.clientAdminFirstName || ""), clientAdminLogin: String(admin.clientAdminLogin || ""), systemAdminLogin: String(admin.systemAdminLogin || ""),
    host, sshUsername: "root", sshPort: 22, databaseMode: "local_peer", databaseHost: String(profile.databaseHost || host), databasePort: Number(profile.databasePort || 5432), databaseUser: "postgres", ...stored.values };
  const saved = { ...stored.saved, clientAdminPassword: stored.saved.clientAdminPassword && stored.values?.clientAdminLogin === admin.clientAdminLogin, systemAdminPassword: stored.saved.systemAdminPassword && stored.values?.systemAdminLogin === admin.systemAdminLogin };
  const server = await clientServers.get(clientId);
  if (!stored.values?.host && server.target) { values.host = server.target.host; values.sshUsername = server.target.username; values.sshPort = server.target.port; }
  if (server.target && server.target.host === values.host && server.target.username === values.sshUsername && server.target.port === values.sshPort && server.passwordSaved) saved.sshPassword = true;
  values.clientAdminLogin = String(admin.clientAdminLogin || ""); values.systemAdminLogin = String(admin.systemAdminLogin || "");
  return { ...stored, values, saved };
}

async function clientServerWithAccess(clientId: string, target?: unknown) {
  const profile = await clientServers.get(clientId, target), access = await installationAccessMetadata(clientId);
  let selected = target ? normalizeRemoteTarget(target) : profile.target;
  if (!selected && access.values.host) selected = normalizeRemoteTarget({ host: access.values.host, username: access.values.sshUsername, port: access.values.sshPort, basePath: "/srv/lms-core/clients", fingerprint: "" });
  return { ...profile, target: profile.target || selected, passwordSaved: profile.passwordSaved || Boolean(selected && await installationAccess.sshSaved(clientId, selected)) };
}
const automaticSourcePreparation = new AutomaticSourcePreparation(projectRoot, value => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("installation:package-progress", value); });
const installationPackages = new InstallationPackageService(projectRoot, sourceSnapshots, id => automaticSourcePreparation.prepare(id));
const clientDesigns = new ClientDesignService(projectRoot, loadInstallationClient, async (clientId) => {
  try {
    const config = await readLauncherConfig(), api = config.services.find((service) => service.id === "api");
    if (!api || !Number.isInteger(api.port) || api.port < 1 || api.port > 65535) throw Error("API_UNAVAILABLE");
    const origin = `http://127.0.0.1:${api.port}`;
    if ((await checkHttpHealth(`${origin}/api/health`, "lms-core-api")).healthState !== "healthy") throw Error("API_IDENTITY");
    const response = await fetch(`${origin}/api/deploy-panel/preview-settings?clientId=${encodeURIComponent(clientId)}`, { redirect: "error", signal: AbortSignal.timeout(7000) });
    if (!response.ok) throw Error("DESIGN_UNAVAILABLE");
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw Error("DESIGN_TOO_LARGE");
    return JSON.parse(text);
  } catch { throw Error("Не удалось прочитать сохраненные настройки редактора из Core API."); }
});
const pointDesigns = new PointDesignService(projectRoot, async (clientId, revision, payload) => {
  try {
    const config = await readLauncherConfig(), api = config.services.find((service) => service.id === "api");
    if (!api || !Number.isInteger(api.port)) throw Error("API_UNAVAILABLE");
    const origin = `http://127.0.0.1:${api.port}`;
    if ((await checkHttpHealth(`${origin}/api/health`, "lms-core-api")).healthState !== "healthy") throw Error("API_IDENTITY");
    const query = new URLSearchParams({ clientId, sourceRevision: revision });
    const response = await fetch(`${origin}/api/deploy-panel/point-design${payload ? "" : `?${query}`}`, { method: payload ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Origin: origin, "Content-Type": "application/json" }, ...(payload ? { body: JSON.stringify({ clientId, sourceRevision: revision, ...(payload as object) }) } : {}) });
    const text = await response.text();
    if (Buffer.byteLength(text) > 150 * 1024) throw Error("POINT_RESPONSE_TOO_LARGE");
    if (!response.ok) throw Error(response.status === 409 ? "Оформление изменено в другом окне. Сначала перечитайте сохраненную версию; черновик не сброшен." : "Не удалось прочитать или сохранить точечное оформление. Проверьте Core API; черновик не сброшен.");
    return JSON.parse(text);
  } catch (error) { throw Error(error instanceof Error ? error.message : "Core API точечного редактора недоступен."); }
});
const newInstallations = new NewInstallationService(projectRoot, sourceSnapshots, remoteTarget, loadInstallationClient, installationPackages, clientDesigns, pointDesigns);
const executionPolicy = new ExecutionPolicy(projectRoot);
const sourceLibrary = new SourceLibraryStore(projectRoot, async () => (await repositoryService.getState()).config);
const serverPreparation = new ServerPreparationService(projectRoot, remoteTarget, newInstallations, (target) => executionPolicy.allowed(target));
const newDeployments = new NewDeploymentService(projectRoot, remoteTarget, newInstallations, installationPackages, {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: (value) => safeStorage.encryptString(value)
}, undefined, (target) => executionPolicy.allowed(target), (clientId, version, revision) => version === 3 && revision ? pointDesigns.currentHash(clientId, revision) : clientDesigns.currentHash(clientId));
const ipPublications = new IpPublicationService(projectRoot, remoteTarget, newDeployments, (target) => executionPolicy.allowed(target));
const managedUpdates = new ManagedUpdateService(projectRoot, remoteTarget, newDeployments, installationPackages, target => executionPolicy.allowed(target));
const archivedUninstallations = new UninstallationService(projectRoot, remoteTarget, newDeployments, (target) => executionPolicy.allowed(target));
const uninstallations = new FullUninstallationService(projectRoot, remoteTarget, newDeployments, archivedUninstallations, target => executionPolicy.allowed(target));
const clientDeletions = new ClientDeletionService(projectRoot, remoteTarget, newDeployments, archivedUninstallations, async () => {
  const config = await readLauncherConfig();
  let secrets: Record<string, string> = {};
  try { secrets = JSON.parse(readFileSync(path.join(projectRoot, "apps/control-center/config/launcher-secrets.json"), "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Не удалось прочитать конфигурацию Core."); }
  return { ...config.environment, ...secrets }.DATABASE_URL;
}, { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value) }, target => executionPolicy.allowed(target));
const aiConfiguration = new AiConfigurationService(projectRoot, remoteTarget, newDeployments, (target) => executionPolicy.allowed(target));
const mailConfiguration = new MailConfigurationService(projectRoot, remoteTarget, newDeployments, (target) => executionPolicy.allowed(target), async (snapshotId, revision) => {
  const source = await sourceSnapshots.verifySnapshot(snapshotId);
  if (source.revision !== revision) throw Error("MAIL_CONTACT_SOURCE_CHANGED");
  return prepareSupportPatch(projectRoot, source.sourcePath);
});
const { appendBoundedLog } = require(path.join(projectRoot, "infra", "scripts", "managed-logs.cjs")) as {
  appendBoundedLog: (root: string, file: string, value: string, maxBytes: number, archives: number) => void;
};
let mainWindow: BrowserWindow | null = null;
let interfacePreferences: InterfacePreferencesStore;

function updateWindowAppearance(preferences: InterfacePreferences): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const theme = themes[preferences.theme];
  mainWindow.setBackgroundColor(theme.background);
  mainWindow.setTitleBarOverlay({ color: "#00000000", symbolColor: theme.text, height: 30 });
}
const nativeLmsView = new NativeLmsView(() => mainWindow);
const nativeGitView = new NativeLmsView(() => mainWindow, path.join(projectRoot, "infra/lms-adapter/point-editor-preload.cjs"));
const pointEditor = new PointEditor(pointDesigns, (state) => {
  if (state.document) nativeGitView.updatePoint({ catalog: state.catalog, document: state.document, enabled: state.enabled, selectedId: state.selectedId });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("point-editor:state", state);
});
const localGitPreview = new LocalGitPreviewService(projectRoot, installationPackages, clientDesigns, loadInstallationClient, async () => {
  const config = await readLauncherConfig();
  let secrets: Record<string, string> = {};
  try { secrets = JSON.parse(readFileSync(path.join(projectRoot, "apps/control-center/config/launcher-secrets.json"), "utf8").replace(/^\uFEFF/, "")); } catch { /* The ordinary local config may contain the database connection. */ }
  const databaseUrl = { ...config.environment, ...secrets }.DATABASE_URL;
  if (!databaseUrl) throw Error("Не настроена локальная PostgreSQL Core.");
  return databaseUrl;
}, (state) => {
  if (state.phase !== "ready") nativeGitView.close();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("git-preview:state", state);
});
const lmsViewer = new LmsViewerService(remoteTarget, newDeployments, (state) => {
  if (state.phase !== "open") nativeLmsView.close();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("viewer:state", state);
});
let serviceOperationInProgress = false;
const servicePhases = new Map<string, "starting" | "stopping">();
const healthRequests = new Map<string, Promise<HealthCheck>>();
const pageReadiness = new PageReadinessCache();
const logTailReader = new LogTailReader();
const statusQueue = createRefreshQueue<ServiceStatus[]>(async (fresh) => {
  const config = await readLauncherConfig();
  return Promise.all(config.services.map((service) => getLiveStatus(service, true, fresh)));
});

function assertRepositorySender(event: Electron.IpcMainInvokeEvent): void {
  const expected = pathToFileURL(path.join(projectRoot, "apps", "control-center", "renderer", "index.html")).href;
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== expected) {
    throw new Error("Управление ключом разрешено только из окна Core.");
  }
}

function resolvePgAdminPath(): string | null {
  const candidates = [
    "C:\\Program Files\\PostgreSQL\\18\\pgAdmin 4\\runtime\\pgAdmin4.exe",
    "C:\\Program Files\\PostgreSQL\\17\\pgAdmin 4\\runtime\\pgAdmin4.exe"
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function writeLauncherLog(message: string): void {
  try {
    appendBoundedLog(path.dirname(launcherLogPath), launcherLogPath, `[${new Date().toISOString()}] ${message}\n`, 1024 * 1024, 2);
  } catch {
    process.stderr.write("Launcher log is unavailable. Check disk space and permissions.\n");
  }
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
}

function createWindow(): BrowserWindow {
  const preferences = interfacePreferences.peek();
  const theme = themes[preferences.theme];
  const window = new BrowserWindow({
    icon: path.join(projectRoot, "apps/control-center/renderer/assets/core-mark.png"),
    width: 1520,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: theme.text,
      height: 30
    },
    autoHideMenuBar: true,
    backgroundColor: theme.background,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Native visibility remains authoritative even when Chromium reports a hidden window as visible.
  let reportedVisibility: boolean | undefined;
  const publishVisibility = (force = false): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const visible = window.isVisible() && !window.isMinimized();
    if (!force && reportedVisibility === visible) return;
    reportedVisibility = visible;
    window.webContents.send("launcher:window-visibility", visible);
  };
  window.on("show", () => publishVisibility());
  window.on("hide", () => publishVisibility());
  window.on("minimize", () => publishVisibility());
  window.on("restore", () => publishVisibility());

  let unloadPromptOpen = false;
  window.webContents.on("will-prevent-unload", (event) => {
    if (unloadPromptOpen) return;
    unloadPromptOpen = true;
    try {
      const leave = confirmPreventedUnload(event, () => dialog.showMessageBoxSync(window, {
        type: "warning",
        title: "Несохраненные изменения",
        message: "На открытой странице есть несохраненные изменения или незавершенная запись.",
        detail: "Останьтесь и сохраните правки. Если уйти, несохраненный ввод потеряется. Уже отправленная запись могла сохраниться на сервере.",
        buttons: ["Остаться", "Уйти без сохранения"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }));
      writeLauncherLog(leave ? "User confirmed leaving an unsaved page." : "Leaving an unsaved page was cancelled.");
    } finally {
      unloadPromptOpen = false;
    }
  });

  window.webContents.on("did-finish-load", () => {
    publishVisibility(true);
    writeLauncherLog("Renderer finished loading.");

    void window.webContents
      .executeJavaScript(
        `JSON.stringify({
          hasLauncherApi: typeof window.launcherApi !== "undefined",
          hasStartAll: Boolean(document.getElementById("start-all-button")),
          hasSidebar: Boolean(document.querySelector(".side-rail")),
          hasFrame: Boolean(document.getElementById("embedded-panel-frame"))
        })`
      )
      .then((result) => {
        writeLauncherLog(`Renderer probe: ${result}`);
      })
      .catch((error) => {
        writeLauncherLog(`Renderer probe failed: ${String(error)}`);
      });
  });

  window.once("ready-to-show", () => {
    if (preferences.maximizeOnStart) window.maximize();
    window.show();
  });

  window.on("closed", () => {
    nativeLmsView.close(); void lmsViewer.close();
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    writeLauncherLog(`Renderer process gone: ${details.reason}`);
  });

  window.webContents.on("did-fail-load", (_event, code, description) => {
    writeLauncherLog(`Renderer failed load: ${code} ${description}`);
  });

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeLauncherLog(`Renderer console [${level}] ${sourceId}:${line} ${message}`);
  });

  window.loadFile(path.join(projectRoot, "apps", "control-center", "renderer", "index.html"));
  mainWindow = window;
  return window;
}

async function runControlAction(
  action: "Status" | "Start" | "Stop",
  serviceId: string
): Promise<ServiceStatus> {
  const config = await readLauncherConfig();
  const service = config.services.find((item) => item.id === serviceId);
  if (!service) throw new Error("Неизвестный сервис.");
  writeLauncherLog(`Control action requested: ${action} ${serviceId}`);
  if (action !== "Status") pageReadiness.invalidate();
  if (action !== "Status") servicePhases.set(serviceId, action === "Start" ? "starting" : "stopping");
  try {
    const parsed = await runJsonCommand<ServiceStatus>(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        controlScriptPath,
        "-Action",
        action,
        "-ServiceId",
        serviceId
      ],
      projectRoot,
      action === "Start" ? 120_000 : 45_000,
      (value): value is ServiceStatus =>
        typeof value === "object" && value !== null && "id" in value && value.id === serviceId
    );

    const deadline = Date.now() + 60_000;
    let live = await getLiveStatus(service, false);
    if (action === "Start" && parsed.ok !== false && parsed.running) {
      while (live.healthState !== "healthy" && live.portOpen && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        live = await getLiveStatus(service, false);
      }
    }
    const healthFailed = action === "Start" && parsed.ok !== false && live.healthState !== "healthy";
    const completed = {
      ...parsed,
      ...live,
      pid: parsed.pid,
      ok: parsed.ok !== false && !healthFailed,
      message: healthFailed ? live.message : parsed.message
    };
    writeLauncherLog(`Control action finished: ${action} ${serviceId} -> running=${completed.running}, health=${completed.healthState}`);
    return completed;
  } finally {
    servicePhases.delete(serviceId);
  }
}

async function readLauncherConfig(): Promise<LauncherConfig> {
  const config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as LauncherConfig;
  // The installed edition decrypts its local database secret in the main process only.
  if (process.env.CORE_DESKTOP_MODE === "1" && process.env.DATABASE_URL) config.environment = { ...config.environment, DATABASE_URL: process.env.DATABASE_URL };
  return config;
}

function probeLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function checkServiceHealth(service: LauncherService, fresh = false): Promise<HealthCheck> {
  const pending = healthRequests.get(service.id);
  if (pending) return pending;
  const request = (async (): Promise<HealthCheck> => {
    if (service.id === "postgres") {
      const config = await readLauncherConfig();
      let secrets: Record<string, string> = {};
      try {
        const secretsPath = path.join(projectRoot, "apps", "control-center", "config", "launcher-secrets.json");
        secrets = JSON.parse(readFileSync(secretsPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, string>;
      } catch {
        // A passwordless local database can still use the ordinary launcher config.
      }
      const environment = { ...config.environment, ...secrets, ...service.environment };
      return checkPostgresHealth(psqlPath, environment.DATABASE_URL || "", service.port);
    }
    const identities: Record<string, string> = {
      api: "lms-core-api",
      "lms-web": "lms-core-lms-web",
      "deploy-panel": "lms-core-deploy-panel"
    };
    const expectedService = identities[service.id];
    if (!expectedService) {
      return { healthState: "unknown", checkedAt: new Date().toISOString(), responseTimeMs: 0, message: "Для этого сервиса проверка пока не настроена." };
    }
    const identity = await checkHttpHealth(`http://127.0.0.1:${service.port}/api/health`, expectedService);
    if (identity.healthState !== "healthy") { pageReadiness.invalidate(); return identity; }
    if (!["lms-web", "deploy-panel"].includes(service.id)) return identity;
    // Next may serve /api/health before its UI compiles. Never report a broken
    // or still-compiling page as ready simply because the small route works.
    const starting = servicePhases.get(service.id) === "starting";
    return pageReadiness.check(`${service.id}:${service.port}`, () => checkLocalPage(`http://127.0.0.1:${service.port}/`, starting ? 60_000 : 3000), fresh || starting);
  })();
  healthRequests.set(service.id, request);
  try {
    return await request;
  } finally {
    if (healthRequests.get(service.id) === request) healthRequests.delete(service.id);
  }
}

async function getLiveStatus(service: LauncherService, includePhase = true, fresh = false): Promise<ServiceStatus> {
  if (!/^[a-z0-9-]+$/i.test(service.id) || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
    throw new Error("Некорректные параметры сервиса в конфигурации.");
  }
  const logsRoot = path.join(projectRoot, "infra", "runtime", "logs");
  const pidFile = path.join(projectRoot, "infra", "runtime", "pids", `${service.id}.pid`);
  const ownerFile = path.join(projectRoot, "infra", "runtime", "pids", `${service.id}.owner.json`);
  let logFile = service.logFile || path.join(logsRoot, `${service.id}.out.log`);
  let errorLogFile = path.join(logsRoot, `${service.id}.err.log`);

  try {
    const owner = JSON.parse(readFileSync(ownerFile, "utf8").replace(/^\uFEFF/, "")) as {
      serviceId?: string;
      logFile?: string;
      errorLogFile?: string;
    };
    const isLogPath = (candidate: unknown): candidate is string =>
      typeof candidate === "string" && path.dirname(path.resolve(candidate)) === path.resolve(logsRoot);
    if (owner.serviceId === service.id) {
      if (!service.logFile && isLogPath(owner.logFile)) logFile = owner.logFile;
      if (isLogPath(owner.errorLogFile)) errorLogFile = owner.errorLogFile;
    }
  } catch {
    // Missing or incomplete runtime metadata must not stop status checks.
  }

  const portOpen = await probeLocalPort(service.port);
  if (!portOpen) pageReadiness.invalidate();
  const health: HealthCheck = portOpen
    ? await checkServiceHealth(service, fresh)
    : { healthState: "stopped", checkedAt: new Date().toISOString(), responseTimeMs: 0, message: "Сервис не слушает локальный порт." };
  return {
    id: service.id,
    label: service.label,
    kind: service.kind,
    port: service.port,
    url: service.url || "",
    logFile,
    errorLogFile,
    pidFile,
    running: portOpen,
    portOpen,
    pid: null,
    ...health,
    state: (includePhase ? servicePhases.get(service.id) : undefined) || health.healthState
  };
}

async function runExclusiveServiceOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (serviceOperationInProgress) {
    throw new Error("Другая операция с сервисами ещё выполняется. Подождите её завершения.");
  }
  serviceOperationInProgress = true;
  try {
    return await operation();
  } finally {
    serviceOperationInProgress = false;
  }
}

async function getPostgresSnapshot(tableName?: string) {
  const config = await readLauncherConfig();
  const service = config.services.find((item) => item.id === "postgres");
  if (!service) throw new Error("PostgreSQL не настроен в Core.");
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(readFileSync(path.join(projectRoot, "apps", "control-center", "config", "launcher-secrets.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch { /* A passwordless local cluster can use the ordinary launcher config. */ }
  const environment = { ...config.environment, ...secrets, ...service.environment };
  return readPostgresSnapshot(localPreviewQuery(psqlPath, environment.DATABASE_URL || "", service.port, projectRoot), tableName);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  writeLauncherLog("Second instance blocked. Quitting duplicate app.");
  app.quit();
} else {
  app.on("second-instance", () => {
    writeLauncherLog("Second instance detected. Focusing existing window.");
    focusMainWindow();
  });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
  writeLauncherLog("Центр управления LMS Core готов.");
  interfacePreferences = new InterfacePreferencesStore(path.join(app.getPath("userData"), "interface-preferences.json"));
  await interfacePreferences.load();
  ipcMain.handle("interface:get-preferences", async (event, legacy: unknown) => {
    assertRepositorySender(event);
    const result = await interfacePreferences.read(legacy);
    updateWindowAppearance(result.preferences);
    return result;
  });
  ipcMain.handle("interface:save-preferences", async (event, input: unknown) => {
    assertRepositorySender(event);
    const preferences = await interfacePreferences.save(input);
    updateWindowAppearance(preferences);
    return preferences;
  });

  ipcMain.handle("launcher:ping", async () => ({
    ok: true,
    timestamp: new Date().toISOString()
  }));
  ipcMain.handle("launcher:get-window-visibility", (event) => {
    assertRepositorySender(event);
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
  });

  ipcMain.handle("launcher:get-config", async () => {
    const config = await readLauncherConfig();
    if (process.env.CORE_DESKTOP_MODE === "1" && config.environment) delete config.environment.DATABASE_URL;
    return config;
  });
  ipcMain.handle("repository:get-state", async (event) => {
    assertRepositorySender(event);
    return repositoryService.getState();
  });
  ipcMain.handle("source-library:get", async (event) => { assertRepositorySender(event); return sourceLibrary.get(); });
  ipcMain.handle("source-library:save", async (event, input: unknown, revision: number) => {
    assertRepositorySender(event);
    const result = await sourceLibrary.save(input, revision);
    writeLauncherLog("Source catalog metadata saved locally."); return result;
  });
  ipcMain.handle("sources:get-state", async (event) => {
    assertRepositorySender(event);
    return sourceSnapshots.getState();
  });
  ipcMain.handle("remote:get-target", async (event) => { assertRepositorySender(event); return remoteTarget.getTarget(); });
  ipcMain.handle("client-server:get", async (event, clientId: string, target?: unknown) => {
    assertRepositorySender(event); return clientServerWithAccess(clientId, target);
  });
  ipcMain.handle("client-server:save", async (event, clientId: string, target: unknown, revision: number) => {
    assertRepositorySender(event); await loadInstallationClient(clientId);
    const saved = await clientServers.saveTarget(clientId, target, revision);
    if (saved.revision !== revision) writeLauncherLog(`Client server profile saved: ${clientId}.`);
    return clientServerWithAccess(clientId, saved.target);
  });
  ipcMain.handle("client-server:password", async (event, clientId: string, target: unknown, password: unknown, revision: number, forget: unknown) => {
    assertRepositorySender(event);
    try {
      await loadInstallationClient(clientId);
      if (typeof forget !== "boolean") throw Error("Некорректное действие замка.");
      const saved = forget ? await clientServers.forget(clientId, target, revision) : await clientServers.remember(clientId, target, password, revision);
      if (forget && await installationAccess.sshSaved(clientId, normalizeRemoteTarget(target))) await installationAccess.forgetSsh(clientId);
      writeLauncherLog(`Client server credential ${forget ? "forgotten" : "remembered"}: ${clientId}.`);
      return saved;
    } finally { password = undefined; }
  });
  ipcMain.handle("installation-access:request", async (event, action: string, clientId: string, input?: InstallationAccess, revision?: number) => {
    assertRepositorySender(event);
    if (action === "get") return installationAccessMetadata(clientId);
    if (!["save", "capture"].includes(action) || !input || accessSaves.has(clientId)) throw Error("Дождитесь сохранения доступов выбранного клиента.");
    accessSaves.add(clientId);
    try {
      const value = installationAccess.validate(input), before = await installationAccessMetadata(clientId);
      if (!installationAccess.available()) throw Error("Хранилище Windows недоступно. Карточка и пароли не изменены.");
      if (before.revision !== revision) throw Error("Доступы изменились. Перечитайте карточку перед сохранением.");
      const detail = await loadInstallationClient(clientId);
      if (action === "capture") {
        if (value.clientAdminLogin !== detail.adminCredentials?.clientAdminLogin || value.systemAdminLogin !== detail.adminCredentials?.systemAdminLogin) throw Error("Логины созданной карточки изменились. Сохраните доступы в ее новом блоке.");
      } else {
        if (!detail.profile) throw Error("У клиента нет сохраненного технического профиля.");
        const config = await readLauncherConfig(), api = config.services.find(service => service.id === "api");
        if (!api) throw Error("Локальный API недоступен.");
        const response = await fetch(`http://127.0.0.1:${api.port}/api/deploy-panel/update-deploy-profile`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(12000), headers: { "content-type": "application/json" },
          body: JSON.stringify(accessProfilePayload(clientId, detail.profile, value)) });
        if (!response.ok) throw Error("Карточка не приняла доступы. Проверьте логины/пароли; защищенное хранилище не изменено.");
      }
      try { await installationAccess.save(clientId, value, before.revision); }
      catch { throw Error("Карточка сохранена, но Windows не подтвердила сохранение паролей для установки. Повторно откройте блок доступов; не создавайте клиента заново."); }
      if (value.host) {
        const server = await clientServers.get(clientId), old = server.target;
        const same = old && old.host === value.host && old.port === value.sshPort && old.username === value.sshUsername;
        const target = { host: value.host, port: value.sshPort, username: value.sshUsername, basePath: old?.basePath || "/srv/lms-core/clients", fingerprint: same ? old.fingerprint : "", ...(same && old.appPath ? { appPath: old.appPath } : {}) };
        const savedServer = await clientServers.saveTarget(clientId, target, server.revision);
        if (value.sshPassword && target.fingerprint) await clientServers.remember(clientId, target, value.sshPassword, savedServer.revision);
      }
      return installationAccessMetadata(clientId);
    } finally { accessSaves.delete(clientId); if (input) for (const key of ["clientAdminPassword", "systemAdminPassword", "sshPassword", "databasePassword"] as const) input[key] = ""; }
  });
  ipcMain.handle("remote:get-state", async (event) => { assertRepositorySender(event); return remoteTarget.getState(); });
  ipcMain.handle("remote:save-target", async (event, input: unknown) => { assertRepositorySender(event); return remoteTarget.saveTarget(input); });
  ipcMain.handle("remote:probe", async (event, input: unknown) => { assertRepositorySender(event); return remoteTarget.probe(input); });
  ipcMain.handle("remote:inspect", async (event, input, credentials) => {
    assertRepositorySender(event);
    const result = await remoteTarget.inspect(input, credentials);
    writeLauncherLog("Remote SSH inventory completed (read-only).");
    return result;
  });
  ipcMain.handle("remote:preflight", async (event, input, credentials, clientId?: string) => {
    assertRepositorySender(event);
    const result = clientId && await newDeployments.get(clientId) ? await managedUpdates.inspect(clientId, input, credentials) : await remoteTarget.preflight(input, credentials);
    writeLauncherLog("Remote update preflight completed (read-only; no deployment).");
    return result;
  });
  ipcMain.handle("deployment:get-state", async (event, clientId?: string) => { assertRepositorySender(event); return clientId && await newDeployments.get(clientId) ? managedUpdates.get(clientId) : remoteDeployment.getState(); });
  const checkedInstallationSource = async (snapshotId: string) => {
    const source = await sourceSnapshots.getState();
    const repository = await repositoryService.getState();
    if (source.phase !== "ready" || source.snapshot?.id !== snapshotId || source.snapshot.repositoryUrl !== repository.config.url ||
        source.snapshot.requestedBranch !== repository.config.branch) throw new Error("Сначала получите код для текущего репозитория и ветки.");
  };
  ipcMain.handle("git-preview:get", (event) => { assertRepositorySender(event); return localGitPreview.get(); });
  ipcMain.handle("git-preview:start", async (event, clientId: string, snapshotId: string) => {
    assertRepositorySender(event);
    if (pointEditor.get().dirty || pointEditor.get().busy) throw Error("Сначала сохраните или отмените правки LMS.");
    await checkedInstallationSource(snapshotId);
    const source = await sourceSnapshots.verifySnapshot(snapshotId);
    return localGitPreview.start(clientId, source);
  });
  ipcMain.handle("git-preview:show", async (event) => {
    assertRepositorySender(event);
    const state = localGitPreview.get();
    if (state.phase !== "ready" || !state.url) throw Error("Локальная Git-LMS пока не запущена.");
    await pointEditor.bind(state.clientId!, state.revision!);
    await nativeGitView.open(state.url);
  });
  ipcMain.on("core-point:ready", (event) => {
    if (!nativeGitView.owns(event)) return;
    const state = pointEditor.get();
    if (state.document) nativeGitView.updatePoint({ catalog: state.catalog, document: state.document, enabled: state.enabled, selectedId: state.selectedId });
  });
  ipcMain.on("core-point:selection", (event, value) => {
    if (typeof value?.session === "string" && nativeGitView.owns(event, value.session)) pointEditor.select(value?.selection);
  });
  const assertPointContext = (requireRunning = true) => {
    const state = localGitPreview.get(), editor = pointEditor.get();
    if (requireRunning && state.phase !== "ready" || state.clientId !== editor.clientId || state.revision !== editor.sourceRevision) throw Error("Выберите просмотр текущего клиента.");
  };
  ipcMain.handle("point-editor:get", (event) => { assertRepositorySender(event); return pointEditor.get(); });
  ipcMain.handle("point-editor:enable", (event, enabled) => { assertRepositorySender(event); assertPointContext(); return pointEditor.enable(enabled); });
  ipcMain.handle("point-editor:change", (event, id, patch) => { assertRepositorySender(event); assertPointContext(); return pointEditor.change(id, patch); });
  ipcMain.handle("point-editor:select", (event, id) => {
    assertRepositorySender(event); assertPointContext();
    pointEditor.enable(true); pointEditor.select({ id }); return pointEditor.get();
  });
  ipcMain.handle("point-editor:save", async (event) => { assertRepositorySender(event); assertPointContext(false); return pointEditor.save(); });
  ipcMain.handle("point-editor:discard", (event) => {
    assertRepositorySender(event); assertPointContext(false);
    if (pointEditor.get().dirty && mainWindow && dialog.showMessageBoxSync(mainWindow, { type: "question", message: "Отменить несохраненные правки LMS?", detail: "Сохраненное оформление клиента не изменится.", buttons: ["Оставить правки", "Отменить правки"], defaultId: 0, cancelId: 0, noLink: true }) !== 1) return pointEditor.get();
    return pointEditor.discard();
  });
  ipcMain.handle("point-editor:reload", async (event) => {
    assertRepositorySender(event); assertPointContext(false);
    if (pointEditor.get().dirty && mainWindow && dialog.showMessageBoxSync(mainWindow, { type: "question", message: "Перечитать сохраненную версию оформления?", detail: "Несохраненный черновик в этом окне будет заменен. Сохраненные данные клиента не удаляются.", buttons: ["Оставить черновик", "Перечитать"], defaultId: 0, cancelId: 0, noLink: true }) !== 1) return pointEditor.get();
    return pointEditor.reload();
  });
  ipcMain.handle("git-preview:stop", async (event) => { assertRepositorySender(event); if (pointEditor.get().dirty || pointEditor.get().busy) throw Error("Сначала сохраните или отмените правки LMS."); nativeGitView.close(); return localGitPreview.stop(); });
  ipcMain.handle("git-preview:layout", (event, bounds) => { assertRepositorySender(event); nativeGitView.layout(bounds); });
  ipcMain.handle("git-preview:reload", (event) => { assertRepositorySender(event); nativeGitView.reload(); });
  ipcMain.handle("git-preview:login", async (event, role) => { assertRepositorySender(event); await nativeGitView.login(await localGitPreview.login(role)); });
  ipcMain.handle("installation:get-plan", async (event, clientId: string) => { assertRepositorySender(event); return newInstallations.get(clientId); });
  ipcMain.handle("installation:get-state", async (event, clientId: string) => { assertRepositorySender(event); return newDeployments.get(clientId); });
  ipcMain.handle("client-deletion:plan", async (event, clientId: string) => { assertRepositorySender(event); return clientDeletions.plan(clientId); });
  ipcMain.handle("client-deletion:execute", async (event, clientId: string, inputTarget, inputAuth) => {
    assertRepositorySender(event);
    let auth = inputAuth;
    try {
      if (!mainWindow || pointEditor.get().dirty || pointEditor.get().busy || localGitPreview.get().clientId === clientId && localGitPreview.get().phase !== "idle" && localGitPreview.get().phase !== "stopped") throw Error("Сохраните правки и остановите локальное Git-превью этого клиента перед удалением.");
      const plan = await clientDeletions.plan(clientId);
      if (plan.target) {
        const saved = await clientServers.get(clientId, plan.target);
        if (saved.passwordSaved) auth = { mode: "password", savedForClient: clientId };
        else {
          if (!auth || auth.mode === "password" && !auth.password || auth.mode === "key" && !auth.identityFile) throw Error("Откройте Репозиторий, укажите SSH-доступ сервера клиента и сохраните пароль замком. Затем повторите удаление в Клиентах.");
          const supplied = normalizeRemoteTarget(inputTarget);
          if (["host", "port", "username", "fingerprint"].some(key => supplied[key as keyof typeof supplied] !== plan.target![key as keyof typeof supplied]) || auth?.savedForClient && auth.savedForClient !== clientId) throw Error("Введите SSH-доступ именно сервера выбранного клиента в Репозитории или сохраните его замком.");
        }
      }
      const result = await clientDeletions.execute(clientId, auth, async current => {
        if (!mainWindow) return false;
        const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "Удаление клиента и базы данных", buttons: ["Отмена", "Удалить клиента и БД"], defaultId: 0, cancelId: 0,
          message: `Удалить клиента «${current.name}»${current.target ? " и его базу данных" : ""}?`,
          detail: current.target ? `Сервер: ${current.target.host}:${current.target.port}\nКаталог: ${current.appPath}\nБД: ${current.database}\n\nLMS будет остановлена. Core создаст проверенную резервную копию и затем УДАЛИТ выделенную базу и ее SQL-роль. После этого будут удалены карточка, пользователи и локальные записи клиента. Рабочая БД исчезнет; восстановление возможно только из резервной копии. Общая БД ядра и другие клиенты не удаляются. Архив приложения и загруженные файлы остаются в /srv/lms-core/backups. При ошибке карточка остается для продолжения проверки.` : "У клиента нет зарегистрированной установки. Будут удалены карточка, пользователи и локальные данные этого клиента. Зашифрованная копия и журнал операции сохранятся; другие клиенты не изменяются." });
        return answer.response === 1;
      }, message => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("client-deletion:progress", { clientId, message }); });
      if (result.phase === "deleted") {
        await clientServers.remove(clientId).catch(() => writeLauncherLog(`Deleted client profile needs local cleanup: ${clientId}`));
        await installationAccess.remove(clientId).catch(() => writeLauncherLog(`Deleted client access needs local cleanup: ${clientId}`));
        if (lmsViewer.get().clientId === clientId) { nativeLmsView.close(); await lmsViewer.close(); }
        writeLauncherLog(`Client and dedicated database deleted: ${clientId}; operation ${result.operationId}.`);
      }
      return result;
    } finally { for (const value of [auth, inputAuth]) if (value) { delete value.password; delete value.passphrase; } }
  });
  ipcMain.handle("uninstallation:get", async (event, clientId: string) => { assertRepositorySender(event); return { state: await uninstallations.get(clientId), accepted: await uninstallations.accepted() }; });
  ipcMain.handle("uninstallation:prepare", async (event, clientId: string, target, credentials) => {
    assertRepositorySender(event);
    try { await loadInstallationClient(clientId); return await uninstallations.prepare(clientId, target, credentials); }
    finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("uninstallation:refresh", async (event, clientId: string, target, credentials) => {
    assertRepositorySender(event); return uninstallations.refresh(clientId, target, credentials);
  });
  ipcMain.handle("uninstallation:execute", async (event, clientId: string, operationId: string, target, credentials) => {
    assertRepositorySender(event);
    try {
      const detail = await loadInstallationClient(clientId), saved = await uninstallations.get(clientId), normalized = normalizeRemoteTarget(target);
      if (!mainWindow || !saved || saved.operationId !== operationId || saved.phase !== "checked" || !await uninstallations.accepted() ||
        ["host", "port", "username", "basePath", "fingerprint"].some(key => normalized[key as keyof typeof normalized] !== saved.target[key as keyof typeof normalized])) throw Error("Сначала выполните проверку удаления для этого клиента и сервера.");
      const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "Полное удаление LMS и базы", buttons: ["Отмена", "Удалить LMS и БД"], defaultId: 0, cancelId: 0,
        message: `Удалить LMS «${String(detail.client.name)}» вместе с БД на ${normalized.host}:${normalized.port}?`,
        detail: `Каталог: ${saved.appPath}\nБаза данных: ${saved.database}\nУстановка: ${saved.jobId}\n\nСайт будет остановлен. Core сначала создаст и проверит резервную копию в /srv/lms-core/backups/${clientId}/${operationId}, затем удалит выделенную БД и SQL-роль, освободит каталог и собственную Linux-учетку, уберет только свои службы/прокси/таймер сертификата. Файлы LMS и настройки HTTPS останутся только в служебном архиве для восстановления, действующий сайт будет удален.\n\nКарточка клиента и сохраненные доступы Core останутся — можно заново установить LMS с пустой БД. Другие сайты, общий PostgreSQL/Nginx, общие пакеты и прежние резервные копии не удаляются. При частичном результате нельзя считать сервер очищенным: сначала проверьте результат удаления.` });
      if (answer.response !== 1) throw Error("Удаление отменено; сервер не изменен.");
      nativeLmsView.close(); await lmsViewer.close();
      const result = await uninstallations.execute(clientId, operationId, target, credentials);
      writeLauncherLog(`Full LMS removal ${result.phase}: ${clientId}; operation ${operationId}; databaseDeleted=${result.databaseDeleted === true}.`);
      return result;
    } finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("execution:mode", async (event) => { assertRepositorySender(event); return executionPolicy.mode(); });
  ipcMain.handle("execution:set-mode", async (event, mode) => {
    assertRepositorySender(event);
    if (mode !== "local" && mode !== "remote") throw Error("Некорректный режим выполнения.");
    if (mode === "remote") { if (!mainWindow) throw Error("Окно закрыто."); const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "Внешние серверы", buttons: ["Оставить локально", "Разрешить внешние цели"], defaultId: 0, cancelId: 0, message: "Разрешить подготовку и установку на внешние SSH-серверы?", detail: "Само переключение ничего на серверы не отправляет. Каждый запуск по-прежнему требует проверенного SSH-отпечатка и отдельного подтверждения цели. Включайте только после завершения локальных проверок и явного решения начать реальный тест." }); if (answer.response !== 1) return executionPolicy.mode(); }
    return executionPolicy.set(mode);
  });
  ipcMain.handle("preparation:get", async (event, clientId: string) => { assertRepositorySender(event); return serverPreparation.get(clientId); });
  ipcMain.handle("preparation:memory", async (event, clientId: string, planId: string, target, credentials) => {
    assertRepositorySender(event);
    try {
      const normalized = normalizeRemoteTarget(target), plan = await newInstallations.get(clientId);
      if (!mainWindow || !await executionPolicy.allowed(normalized) || !plan || plan.id !== planId || ["host", "port", "username", "basePath", "fingerprint"].some((key) => normalized[key as keyof typeof normalized] !== plan.target[key as keyof typeof normalized])) throw Error("Сначала подготовьте план для выбранного подтвержденного сервера.");
      newInstallations.assertProfileCurrent(plan, await loadInstallationClient(clientId));
      const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "Память для сборки LMS", buttons: ["Отмена", "Добавить swap"], defaultId: 0, cancelId: 0,
        message: `Добавить swap на ${normalized.host}:${normalized.port}?`,
        detail: `Клиент: ${plan.client.name}\nCore при необходимости создаст отдельный файл /srv/lms-core/memory/build-4g.swap размером 4 ГиБ. Он будет активен до перезагрузки; файл автоматически не удаляется. Чужие swap-файлы не заменяются, swapoff и изменения /etc/fstab не выполняются. Нужно 11 ГиБ свободного места, чтобы сохранить 7 ГиБ для сборки. Повторная команда не создает дубликаты. Это изменение выбранного сервера, не проверка.` });
      if (answer.response !== 1) throw Error("Добавление swap отменено; сервер не изменен.");
      newInstallations.assertProfileCurrent(plan, await loadInstallationClient(clientId));
      return await serverPreparation.prepareMemory(clientId, planId, target, credentials);
    } finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("preparation:start", async (event, clientId: string, planId: string, target, credentials) => {
    assertRepositorySender(event);
    try {
      const normalized = normalizeRemoteTarget(target);
      if (!mainWindow || !await executionPolicy.allowed(normalized)) throw new Error("Локальный режим: внешний сервер не изменён.");
      const plan = await newInstallations.get(clientId);
      if (!plan || plan.id !== planId || ["host", "port", "username", "basePath", "fingerprint"].some(key => normalized[key as keyof typeof normalized] !== plan.target[key as keyof typeof normalized])) throw Error("Подготовьте план для выбранного сервера; подготовка Ubuntu не запускалась.");
      newInstallations.assertProfileCurrent(plan, await loadInstallationClient(clientId));
      const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "Подготовка чистого сервера", buttons: ["Отмена", "Подготовить Ubuntu"], defaultId: 0, cancelId: 0,
        message: `Подготовить Ubuntu на ${normalized.host}:${normalized.port}?`, detail: "Ubuntu 24.04 или 26.04 amd64/root/systemd. Core установит необходимые пакеты, отдельный Node 22 и PostgreSQL, если их нет. Совместимые существующие Node/БД не заменяются, пароли не сбрасываются. SSH/firewall/другие сайты не перенастраиваются. Swap и общий apt upgrade не выполняются. Это изменение выбранного сервера, не проверка." });
      if (answer.response !== 1) throw new Error("Подготовка отменена; сервер не изменён.");
      newInstallations.assertProfileCurrent(plan, await loadInstallationClient(clientId));
      return await serverPreparation.prepare(clientId, planId, target, credentials, (state) => { if (!event.sender.isDestroyed()) event.sender.send("preparation:progress", state); });
    } finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("preparation:refresh", async (event, clientId: string, target, credentials) => { assertRepositorySender(event); return serverPreparation.refresh(clientId, target, credentials, (state) => { if (!event.sender.isDestroyed()) event.sender.send("preparation:progress", state); }); });
  ipcMain.handle("viewer:open", async (event, clientId: string, target, credentials) => {
    assertRepositorySender(event);
    try { const state = await lmsViewer.open(clientId, target, credentials); await nativeLmsView.open(state.url!); return state; }
    catch (error) { await lmsViewer.close(); throw error; }
    finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("viewer:close", async (event) => { assertRepositorySender(event); nativeLmsView.close(); await lmsViewer.close(); return lmsViewer.get(); });
  ipcMain.handle("viewer:layout", (event, bounds) => { assertRepositorySender(event); nativeLmsView.layout(bounds); });
  ipcMain.handle("viewer:reload", (event) => { assertRepositorySender(event); nativeLmsView.reload(); });
  ipcMain.handle("publication:get", async (event, clientId: string) => { assertRepositorySender(event); return ipPublications.get(clientId); });
  ipcMain.handle("ai-configuration:get", async (event, clientId: string) => { assertRepositorySender(event); return aiConfiguration.get(clientId); });
  ipcMain.handle("ai-configuration:provision", async (event, clientId: string, targetInput, credentials, settings) => {
    try {
      assertRepositorySender(event);
      const detail = await loadInstallationClient(clientId), target = normalizeRemoteTarget(targetInput), saved = await newDeployments.get(clientId);
      if (!mainWindow || !saved || saved.phase !== "succeeded" || !await executionPolicy.allowed(saved.target) || ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof typeof target] !== saved.target[key as keyof typeof target])) throw Error("Выберите точную разрешенную SSH-цель установленной LMS.");
      const normalized = normalizeAiProvisionInput(settings);
      delete normalized.AI_API_KEY;
      const answer = await dialog.showMessageBox(mainWindow, { type: "warning", buttons: ["Отмена", "Создать базу и подключить"], defaultId: 0, cancelId: 0,
        title: "База знаний ИИ через Core", message: `Подготовить отдельную базу знаний для ${String(detail.client.name || "выбранного клиента")} на ${saved.target.host}?`,
        detail: `Каталог Яндекса: ${normalized.AI_PROJECT_ID}\nPrompt: ${normalized.AI_PROMPT_ID}\nLMS: ${saved.target.appPath}\n\nCore использует введенный API-ключ либо уже сохраненный на этом сервере. В Яндексе будет создан пустой Vector Store с привязкой к этому клиенту; повтор использует свою ранее созданную базу. Чужие базы и материалы не переносятся и не удаляются. Файлы не загружаются, генерация и поиск не вызываются. Последующее хранение/индексация материалов оплачиваются по тарифам Яндекса.\n\nПолученный ID и параметры подключения будут записаны в серверное окружение, только веб-служба LMS кратко перезапустится. Код LMS не меняется. При ошибке применения сохраняется база для повторного подключения, а прежнее окружение восстанавливается. Работа самого чата этим действием не проверяется.` });
      if (answer.response !== 1) throw Error("Настройка ИИ отменена; ресурсы не создавались.");
      const result = await aiConfiguration.execute(clientId, target, credentials, settings, false, true);
      writeLauncherLog(`AI managed index: client=${clientId}; phase=${result.phase}; reused=${result.indexReused === true}.`);
      return result;
    } finally {
      if (settings && typeof settings === "object") delete settings.AI_API_KEY;
      if (credentials) { delete credentials.password; delete credentials.passphrase; }
    }
  });
  ipcMain.handle("ai-configuration:execute", async (event, clientId: string, targetInput, credentials, settings, checkOnly: unknown) => {
    try {
      assertRepositorySender(event);
      const target = normalizeRemoteTarget(targetInput), saved = await newDeployments.get(clientId);
      if (!saved || saved.phase !== "succeeded" || !await executionPolicy.allowed(saved.target) || ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof typeof target] !== saved.target[key as keyof typeof target])) throw Error("Выберите точную разрешенную SSH-цель установленной LMS.");
      const reading = checkOnly === true;
      if (!reading) {
        normalizeAiInput(settings);
        const answer = await dialog.showMessageBox(mainWindow!, { type: "warning", buttons: ["Отмена", "Сохранить ИИ и применить"], defaultId: 0, cancelId: 0,
          title: "Параметры ИИ выбранной LMS", message: `Сохранить настройки Alice AI на ${saved.target.host}?`,
          detail: `Клиент: ${clientId}\nУстановка: ${saved.target.appPath}\n\nCore обновит только AI_API_KEY, AI_PROJECT_ID, AI_PROMPT_ID и AI_VECTOR_STORE_ID в защищенном серверном .env.production.local. Остальные переменные будут сохранены. Веб-служба этой LMS кратко перезапустится; API, PostgreSQL и соседние сайты не останавливаются. При неудачной проверке будет попытка отката.\n\nТокен доступен root и веб-службе на сервере. На ноутбуке он передаётся только через память Core, не сохраняется на диск и не выводится в журнал. Запрос к провайдеру ИИ и проверка оплаты не выполняются.` });
        if (answer.response !== 1) throw Error("Настройка ИИ отменена; сервер не изменён.");
      }
      const result = await aiConfiguration.execute(clientId, target, credentials, settings, reading);
      writeLauncherLog(`AI configuration ${reading ? "check" : "apply"}: client=${result.clientId}; phase=${result.phase}.`);
      return result;
    } finally {
      if (settings && typeof settings === "object") delete settings.AI_API_KEY;
      if (credentials) { delete credentials.password; delete credentials.passphrase; }
    }
  });
  ipcMain.handle("mail-configuration:get", async (event, clientId: string) => { assertRepositorySender(event); return mailConfiguration.get(clientId); });
  ipcMain.handle("mail-configuration:execute", async (event, clientId: string, targetInput, credentials, action: MailAction, settings, recipient: string) => {
    try {
      assertRepositorySender(event);
      if (!["apply", "check", "test"].includes(action) || !mainWindow) throw Error("Неизвестная команда настройки почты.");
      const target = normalizeRemoteTarget(targetInput), saved = await newDeployments.get(clientId);
      if (!saved || saved.phase !== "succeeded" || !await executionPolicy.allowed(saved.target) || ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof typeof target] !== saved.target[key as keyof typeof target])) throw Error("Выберите точную разрешенную SSH-цель установленной LMS.");
      if (action === "apply") mailConfiguration.normalizeInput(settings);
      if (action === "test" && !mailConfiguration.validRecipient(recipient)) throw Error("Укажите один корректный адрес получателя тестового письма.");
      if (action !== "check") {
        const testing = action === "test";
        const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: testing ? "Тестовое письмо" : "Почта выбранной LMS", buttons: ["Отмена", testing ? "Отправить одно письмо" : "Сохранить почту и применить"], defaultId: 0, cancelId: 0,
          message: testing ? `Отправить тестовое письмо на ${recipient}?` : `Сохранить почтовые настройки на ${saved.target.host}?`,
          detail: `Клиент: ${clientId}\nСервер: ${saved.target.host}:${saved.target.port}\nУстановка: ${saved.target.appPath}\n\n${testing ? "Письмо отправится с выбранного сервера через уже сохраненную SMTP-настройку, не через черновик формы. Получатель: " + recipient + ". Никакой массовой рассылки. Прием SMTP-сервером еще не гарантирует попадание во входящие; проверьте также Спам." : "Core обновит SMTP, SUPPORT_EMAIL и контакт VAPID, сохранив ИИ и остальные значения. Для старой LMS сначала отдельно соберется адаптер поддержки из ее проверенной версии; до переключения старый сайт работает. Первая сборка может занять до 45 минут. Дальнейшая смена адреса не требует пересборки. Кратко перезапускается только web, при сбое будет попытка отката. Сохранение не отправляет писем."}\n\nПароль приложения не сохраняется на диск ноутбука и не выводится в журнал. На сервере он доступен root и веб-службе. Адрес отправителя становится контактом поддержки в футере, mailto-ссылках и существующих текстах политики; адреса сотрудников не меняются.` });
        if (answer.response !== 1) throw Error("Настройка почты отменена; сервер и получатель не изменены.");
      }
      const result = await mailConfiguration.execute(clientId, target, credentials, action, settings, recipient);
      writeLauncherLog(`Mail configuration ${action}: client=${result.clientId}; phase=${result.phase}.`);
      return result;
    } finally {
      if (settings && typeof settings === "object") delete settings.SMTP_PASS;
      if (credentials) { delete credentials.password; delete credentials.passphrase; }
    }
  });
  ipcMain.handle("publication:execute", async (event, clientId: string, target, credentials, checkOnly: boolean, https = false) => {
    assertRepositorySender(event);
    try {
      if (!mainWindow || typeof checkOnly !== "boolean" || typeof https !== "boolean" || checkOnly && https) throw Error("Окно Core или команда публикации недоступны.");
      const saved = await newDeployments.get(clientId), normalized = normalizeRemoteTarget(target);
      if (!saved || saved.phase !== "succeeded" || ["host", "port", "username", "basePath", "fingerprint"].some((key) => normalized[key as keyof typeof normalized] !== saved.target[key as keyof typeof normalized])) throw Error("Выберите SSH-цель установленной LMS.");
      if (!await executionPolicy.allowed(normalized)) throw Error("Локальный режим: внешний сервер не изменён.");
      if (!checkOnly) {
        const answer = https ? await dialog.showMessageBox(mainWindow, { type: "warning", title: "HTTPS для LMS по IP", buttons: ["Отмена", "Принять условия и включить HTTPS"], defaultId: 0, cancelId: 0,
          message: `Включить https://${normalized.host} для установленного клиента?`,
          detail: `SSH: ${normalized.host}:${normalized.port}\nКаталог: ${saved.target.appPath}\n\nНужны публичные порты80 и443 и уже настроенный HTTP-доступ Core. Core установит отдельный Certbot, зарегистрирует ACME-аккаунт без email и запросит сертификат Let's Encrypt для этого IP. Нажимая кнопку, вы принимаете условия удостоверяющего центра: https://letsencrypt.org/repository/ . IP попадет в публичные журналы Certificate Transparency. Это не скрытый/приватный адрес.\n\nСтарый HTTP работает до переключения. После проверки сертификата включатся HTTPS и перенаправление с HTTP; при активном UFW добавится только443/tcp. Ключ остается на сервере. Продление с перечитыванием сертификата Nginx выполняется на сервере автоматически, независимо от Core и ноутбука. Порт80 нужно оставить открытым для проверки владения.\n\nОперация может занять до40минут. При сбое Core попытается вернуть свой прежний Nginx-конфиг; БД, материалы и внутренние сервисы не переустанавливаются.` }) : await dialog.showMessageBox(mainWindow, { type: "warning", title: "Тестовый доступ к LMS по IP", buttons: ["Отмена", "Опубликовать по IP"], defaultId: 0, cancelId: 0,
          message: `Открыть http://${normalized.host} для клиента на этом сервере?`,
          detail: `SSH: ${normalized.host}:${normalized.port}\nКаталог: ${saved.target.appPath}\n\nCore установит Nginx при необходимости и создаст отдельный прокси на порту80. При активном UFW добавит только80/tcp. Сама LMS, БД и внутренний API остаются на localhost. Чужие конфиги не заменяются.\n\nВНИМАНИЕ: это HTTP без шифрования. Пароли и данные могут быть перехвачены. Используйте только временные тестовые учетки и ненастоящие данные. Для реальной работы нужен HTTPS.` });
        if (answer.response !== 1) throw Error("Публикация отменена; сервер не изменён.");
      }
      if (!checkOnly && !https) await lmsViewer.close();
      return await ipPublications.execute(clientId, target, credentials, checkOnly, https);
    } finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("installation:package", async (event, clientId: string, planId: string, snapshotId: string) => {
    assertRepositorySender(event); await checkedInstallationSource(snapshotId);
    const plan = await newInstallations.get(clientId);
    if (plan?.source.snapshotId !== snapshotId) throw new Error("Git-источник изменился. Пересоздайте план.");
    return newInstallations.preparePackage(clientId, planId);
  });
  ipcMain.handle("installation:start", async (event, clientId: string, planId: string, snapshotId: string, target, credentials, secrets) => {
    assertRepositorySender(event);
    try {
      await checkedInstallationSource(snapshotId);
      const plan = await newInstallations.get(clientId);
      if (!mainWindow || plan?.source.snapshotId !== snapshotId || plan.id !== planId) throw new Error("План изменился. Подготовьте его заново.");
      const normalized = normalizeRemoteTarget(target);
      if (!await executionPolicy.allowed(normalized)) throw new Error("Локальный режим: внешний хост не изменён.");
      const detail = await loadInstallationClient(clientId);
      const raw = detail.client;
      newInstallations.assertProfileCurrent(plan, detail);
      const db = require(path.join(projectRoot, "packages/db/dist/src/index.js")) as { normalizeFreshClient(value: unknown): Record<string, unknown> };
      const client = installationClient(raw, db.normalizeFreshClient);
      assertNewInstallationReady(plan, planId, normalized, client);
      const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "Новая установка LMS", buttons: ["Отмена", "Установить в Linux"], defaultId: 0, cancelId: 0,
        message: `Создать LMS «${plan.client.name}» на ${normalized.host}:${normalized.port}?`,
        detail: `Репозиторий: ${plan.source.repositoryUrl}\nВетка: ${plan.source.branch}\nCommit: ${plan.source.revision}\nРежим: управляемая LMS — Git-код + backend и адаптеры Core, не неизмененный Git\nКаталог: ${plan.paths.root}\nМатериалы: ${plan.contentMode === "source" ? `из выбранного Git, тем ${plan.package?.curriculum?.topics ?? 0}, тестов ${plan.package?.curriculum?.tests ?? 0}, вопросов ${plan.package?.curriculum?.questions ?? 0}` : "пустая учебная база"}\nПользователи и прогресс из Git не переносятся. Наполнение будет проверено до объявления успеха.\n\nБудут созданы отдельные DB/роль, пользователь Linux и службы systemd. Существующий сайт не заменяется. Доступы из карточки хранятся зашифрованно в профиле Windows и используются только для выбранного клиента. Служебный пароль новой DB создается автоматически. После запуска проверяйте прогресс, не повторяйте установку.` });
      if (answer.response !== 1) throw new Error("Установка отменена; сервер не изменён.");
      // A confirmation dialog can stay open while another window changes the card or selected Git.
      await checkedInstallationSource(snapshotId);
      const latest = await loadInstallationClient(clientId);
      newInstallations.assertProfileCurrent(plan, latest);
      const currentClient = installationClient(latest.client, db.normalizeFreshClient);
      assertNewInstallationReady(plan, planId, normalized, currentClient);
      secrets = await installationAccess.resolve(clientId, secrets, { clientAdminLogin: String(latest.adminCredentials?.clientAdminLogin || ""), systemAdminLogin: String(latest.adminCredentials?.systemAdminLogin || "") });
      return await newDeployments.start(clientId, planId, target, credentials, secrets, currentClient, (state) => { if (!event.sender.isDestroyed()) event.sender.send("installation:progress", state); });
    } finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } if (secrets) { secrets.maintenanceUrl = ""; secrets.clientAdminPassword = ""; secrets.systemAdminPassword = ""; } }
  });
  ipcMain.handle("installation:refresh", async (event, clientId: string, target, credentials) => {
    assertRepositorySender(event);
    return newDeployments.refresh(clientId, target, credentials, (state) => { if (!event.sender.isDestroyed()) event.sender.send("installation:progress", state); });
  });
  ipcMain.handle("installation:recover", async (event, clientId: string, target, credentials) => {
    assertRepositorySender(event);
    try {
      const state = await newDeployments.get(clientId), detail = await loadInstallationClient(clientId);
      if (!mainWindow || !state?.retryAvailable || state.phase !== "needs_attention") throw Error("Сначала обновите результат остановленного задания; Core проверит его ресурсы автоматически.");
      const resumeContent = state.failedStep === "bootstrap" && state.errorCode === "CURRICULUM_INSTALL_VERIFY_FAILED";
      const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "Восстановление запуска", buttons: ["Отмена", "Восстановить запуск"], defaultId: 0, cancelId: 0,
        message: resumeContent ? `Продолжить остановленную установку «${String(detail.client.name)}»?` : `Восстановить возможность установки для «${String(detail.client.name)}»?`,
        detail: `Сервер: ${state.target.host}\nКаталог: ${state.target.appPath}\nЗадание: ${state.id}\n\n${resumeContent
          ? "Core проверит прежний пакет, владельца задания и сохранённые ключи. Затем проверит учебные материалы и запустит службы этой LMS. Уже созданные БД, администраторы и их пароли сохранятся: повторного создания или удаления не будет. При несовпадении данных продолжение остановится."
          : `Core повторно проверит отсутствие БД/SQL-роли, собственные метки и неиспользуемую служебную учетку. Только папка неудачной подготовки будет перенесена в /srv/lms-core/recovery/${state.id}, затем ее Linux-учетка удалится. Существующие БД, сайты и резервные копии не удаляются. Установка LMS автоматически не запускается.`}` });
      if (answer.response !== 1) throw Error("Восстановление отменено; сервер не изменен.");
      return await newDeployments.recover(clientId, target, credentials, state => { if (!event.sender.isDestroyed()) event.sender.send("installation:progress", state); });
    } finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("installation:prepare", async (event, clientId: string, snapshotId: string, target: unknown, contentMode: unknown) => {
    assertRepositorySender(event);
    if (contentMode !== "empty" && contentMode !== "source") throw Error("Выберите наполнение LMS: темы и тесты из Git или пустая база.");
    if (pointEditor.get().clientId === clientId && (pointEditor.get().dirty || pointEditor.get().busy)) throw Error("Сначала сохраните или отмените правки LMS. Несохраненный черновик не входит в установку.");
    await checkedInstallationSource(snapshotId);
    const plan = await newInstallations.prepare(clientId, snapshotId, target, "source", contentMode);
    writeLauncherLog(`New installation plan prepared: ${plan.id}; ${plan.status}. No remote writes.`);
    return plan;
  });
  ipcMain.handle("installation:check-server", async (event, clientId: string, planId: string, snapshotId: string, target, credentials) => {
    assertRepositorySender(event);
    try {
      await checkedInstallationSource(snapshotId);
      const saved = await newInstallations.get(clientId);
      if (saved?.source.snapshotId !== snapshotId) throw new Error("Источник плана устарел. Подготовьте его заново.");
      const plan = await newInstallations.checkServer(clientId, planId, target, credentials);
      writeLauncherLog(`New installation server preflight completed: ${plan.id}. Read-only; no installation.`);
      return plan;
    } finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("deployment:start", async (event, input, credentials, snapshotId: string, allowSwap: boolean, clientId?: string) => {
    assertRepositorySender(event);
    try {
      const installed = clientId ? await newDeployments.get(clientId) : null;
      const target = installed ? resolveManagedUpdateTarget(input, installed, clientId!) : normalizeRemoteTarget(input);
      const source = await sourceSnapshots.getState();
      const repository = await repositoryService.getState();
      if (source.phase !== "ready" || source.snapshot?.id !== snapshotId || source.snapshot.repositoryUrl !== repository.config.url ||
          source.snapshot.requestedBranch !== repository.config.branch) throw new Error("Получите код для текущего выбранного репозитория и ветки перед обновлением.");
      if (!mainWindow) throw new Error("Окно приложения недоступно.");
      const answer = await dialog.showMessageBox(mainWindow, { type: "warning", title: "Обновление LMS на сервере", buttons: ["Отмена", "Обновить LMS"], defaultId: 0, cancelId: 0,
        message: `Обновить LMS на ${target.host}?`,
        detail: `Источник: ${source.snapshot.repositoryUrl}\nВетка: ${source.snapshot.branch}\nCommit: ${source.snapshot.revision}\nКаталог: ${target.appPath || "не указан"}\n\n${installed ? "Управляемая LMS: новый Git-код проходит адаптер Core и отдельную сборку. Обновится только web; backend, БД, администраторы, ИИ, почта, HTTPS и файлы сохранятся. Прежний код останется резервной копией. При ошибке запуска — автоматический откат. Схема БД не меняется." : `Сборка пройдёт отдельно. Затем сайт кратко остановится для проверенного backup и замены кода. Клиентские данные и окружение сохраняются. При сбое будет попытка автоматического возврата.\nSwap до 4 GiB при нехватке памяти: ${allowSwap === true ? "разрешён, без автозагрузки" : "не разрешён"}.`}` });
      if (answer.response !== 1) throw new Error("Обновление отменено. Сервер не изменялся.");
      const report = (state: import("./remote-deployment").DeploymentState) => {
        if (!event.sender.isDestroyed()) event.sender.send("deployment:progress", state);
      };
      const result = installed ? await managedUpdates.deploy(clientId!, target, credentials, snapshotId, report) : await remoteDeployment.deploy(target, credentials, snapshotId, allowSwap === true, report);
      writeLauncherLog(`Remote update: ${result.id}; ${result.phase}; ${result.errorCode || "no error code"}`);
      return result;
    } finally { if (credentials) { delete credentials.password; delete credentials.passphrase; } }
  });
  ipcMain.handle("deployment:refresh", async (event, input, credentials, clientId?: string) => {
    assertRepositorySender(event);
    const report = (state: import("./remote-deployment").DeploymentState) => { if (!event.sender.isDestroyed()) event.sender.send("deployment:progress", state); };
    return clientId && await newDeployments.get(clientId) ? managedUpdates.refresh(clientId, input, credentials, report) : remoteDeployment.refresh(input, credentials, report);
  });
  ipcMain.handle("sources:fetch", async (event, input: unknown) => {
    assertRepositorySender(event);
    const checked = await repositoryService.check(input);
    if (checked.result?.status !== "connected") throw new Error(checked.result?.message || "Доступ к источнику не подтвержден.");
    const state = await sourceSnapshots.fetch(checked.config, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("sources:progress", progress);
    });
    writeLauncherLog(`Source fetch completed: ${state.phase}; ${state.snapshot?.revision || "no snapshot"}`);
    return { source: state, repository: checked };
  });
  ipcMain.handle("repository:check", async (event, input: unknown) => {
    assertRepositorySender(event);
    const state = await repositoryService.check(input);
    writeLauncherLog(`Repository read check: ${state.result?.status || "unknown"}`);
    return state;
  });
  ipcMain.handle("repository:choose-key", async (event) => {
    assertRepositorySender(event);
    if (!mainWindow) return null;
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите приватный SSH-ключ (не .pub)", properties: ["openFile"],
      defaultPath: path.join(app.getPath("home"), ".ssh")
    });
    return selected.canceled ? null : selected.filePaths[0] || null;
  });
  ipcMain.handle("repository:create-key", async (event) => {
    assertRepositorySender(event);
    if (!mainWindow) throw new Error("Окно Core недоступно.");
    const existing = await repositoryService.getManagedKey();
    if (existing.available) return existing;
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "question", title: "Отдельный SSH-ключ Core",
      message: "Создать отдельный ключ для чтения репозитория?",
      detail: "Старые ключи не меняются. Закрытая часть будет защищена хранилищем Windows. В GitHub нужно отдельно добавить только публичную часть как Deploy key, без права записи.",
      buttons: ["Создать ключ", "Отмена"], defaultId: 0, cancelId: 1, noLink: true
    });
    if (confirmation.response !== 0) return null;
    const key = await repositoryService.createManagedKey();
    writeLauncherLog("Separate Core repository key created using OS-protected storage.");
    return key;
  });
  ipcMain.handle("repository:copy-public-key", async (event) => {
    assertRepositorySender(event);
    const key = await repositoryService.getManagedKey();
    if (!key.available) throw new Error("Сначала создайте отдельный ключ Core.");
    clipboard.writeText(key.publicKey);
    return true;
  });
  ipcMain.handle("repository:open-github-settings", async (event, input: unknown) => {
    assertRepositorySender(event);
    const config = normalizeRepositoryConfig(input);
    const match = /^git@github\.com:([a-z0-9_.-]+)\/([a-z0-9_.-]+?)(?:\.git)?$/i.exec(config.url);
    if (!match) throw new Error("Автоматическое открытие настроек доступно для SSH-адреса GitHub вида git@github.com:owner/repository.git.");
    await shell.openExternal(`https://github.com/${match[1]}/${match[2]}/settings/keys`);
    return true;
  });
  ipcMain.handle("launcher:fetch-json", async (_event, url: string) => {
    if (!url) {
      throw new Error("URL не передан.");
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(7_000) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return response.json();
  });

  ipcMain.handle("launcher:get-statuses", async (_event, options?: { fresh?: boolean }) => statusQueue.request(options?.fresh === true));

  ipcMain.handle("launcher:start-service", async (_event, serviceId: string) =>
    runExclusiveServiceOperation(() => runControlAction("Start", serviceId))
  );

  ipcMain.handle("launcher:stop-service", async (_event, serviceId: string) =>
    runExclusiveServiceOperation(() => runControlAction("Stop", serviceId))
  );

  const runAll = async (
    action: "Start" | "Stop",
    reportProgress: (message: string) => void
  ): Promise<ServiceStatus[]> => {
    const config = await readLauncherConfig();
    const services = action === "Start" ? config.services : [...config.services].reverse();
    const results: ServiceStatus[] = [];
    for (const [index, service] of services.entries()) {
      reportProgress(`${action === "Start" ? "Запуск" : "Остановка"}: ${service.label} (${index + 1}/${services.length})`);
      try {
        results.push(await runControlAction(action, service.id));
      } catch (error) {
        writeLauncherLog(`Control action failed: ${action} ${service.id}: ${String(error)}`);
        const status = await getLiveStatus(service);
        results.push({ ...status, ok: false, message: "Операция не выполнена. Проверьте системный журнал." });
      }
    }
    return results;
  };

  ipcMain.handle("launcher:start-all", async (event) =>
    runExclusiveServiceOperation(() => runAll("Start", (message) => {
      if (!event.sender.isDestroyed()) event.sender.send("launcher:operation-progress", message);
    }))
  );

  ipcMain.handle("launcher:stop-all", async (event) =>
    runExclusiveServiceOperation(() => runAll("Stop", (message) => {
      if (!event.sender.isDestroyed()) event.sender.send("launcher:operation-progress", message);
    }))
  );

  ipcMain.handle("launcher:open-url", async (_event, url: string) => {
    if (!url) {
      return false;
    }

    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("launcher:open-file", async (_event, filePath: string) => {
    if (!filePath) {
      return false;
    }

    const result = await shell.openPath(filePath);
    return result.length === 0;
  });

  ipcMain.handle("launcher:open-config", async () => {
    const result = await shell.openPath(configPath);
    return result.length === 0;
  });

  ipcMain.handle("launcher:open-pgadmin", async () => {
    const pgAdminPath = resolvePgAdminPath();

    if (!pgAdminPath) {
      throw new Error("pgAdmin не найден на этом ноутбуке.");
    }

    const result = await shell.openPath(pgAdminPath);
    return result.length === 0;
  });

  ipcMain.handle("launcher:read-log", async (event, filePath: string, options?: { fresh?: boolean }) => {
    assertRepositorySender(event);
    return logTailReader.read(filePath, undefined, options?.fresh === true);
  });

  ipcMain.handle("launcher:get-postgres-snapshot", async (event, tableName?: string) => {
    assertRepositorySender(event);
    return getPostgresSnapshot(tableName);
  });

  ipcMain.handle("launcher:get-launcher-log-path", async () => launcherLogPath);

  createWindow();

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      focusMainWindow();
      return;
    }

    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
  });
}

app.on("window-all-closed", () => {
  writeLauncherLog("All windows closed.");

  if (process.platform !== "darwin") {
    app.quit();
  }
});

let preferencesFlushed = false;
app.on("before-quit", (event) => {
  if (!interfacePreferences || preferencesFlushed) return;
  event.preventDefault();
  nativeGitView.close();
  void Promise.all([interfacePreferences.flush(), localGitPreview.stop()]).catch(() => writeLauncherLog("Не удалось завершить сохранение настроек или остановку Git-просмотра.")).finally(() => {
    preferencesFlushed = true;
    app.quit();
  });
});

process.on("uncaughtException", (error) => {
  writeLauncherLog(`Uncaught exception: ${error.stack ?? error.message}`);
});

process.on("unhandledRejection", (reason) => {
  writeLauncherLog(`Unhandled rejection: ${String(reason)}`);
});
