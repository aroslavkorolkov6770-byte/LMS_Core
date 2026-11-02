import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("launcherApi", {
  ping: () => ipcRenderer.invoke("launcher:ping"),
  getWindowVisibility: () => ipcRenderer.invoke("launcher:get-window-visibility"),
  onWindowVisibility: (callback: (visible: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, visible: unknown) => {
      if (typeof visible === "boolean") callback(visible);
    };
    ipcRenderer.on("launcher:window-visibility", handler);
    return () => ipcRenderer.removeListener("launcher:window-visibility", handler);
  },
  getConfig: () => ipcRenderer.invoke("launcher:get-config"),
  getInterfacePreferences: (legacy?: unknown) => ipcRenderer.invoke("interface:get-preferences", legacy),
  saveInterfacePreferences: (preferences: unknown) => ipcRenderer.invoke("interface:save-preferences", preferences),
  getRepository: () => ipcRenderer.invoke("repository:get-state"),
  checkRepository: (config: unknown) => ipcRenderer.invoke("repository:check", config),
  chooseRepositoryKey: () => ipcRenderer.invoke("repository:choose-key"),
  createRepositoryKey: () => ipcRenderer.invoke("repository:create-key"),
  copyRepositoryPublicKey: () => ipcRenderer.invoke("repository:copy-public-key"),
  openRepositoryGitHubSettings: (config: unknown) => ipcRenderer.invoke("repository:open-github-settings", config),
  getSourceState: () => ipcRenderer.invoke("sources:get-state"),
  getGitPreview: () => ipcRenderer.invoke("git-preview:get"),
  startGitPreview: (clientId: string, snapshotId: string) => ipcRenderer.invoke("git-preview:start", clientId, snapshotId),
  showGitPreview: () => ipcRenderer.invoke("git-preview:show"),
  stopGitPreview: () => ipcRenderer.invoke("git-preview:stop"),
  layoutGitPreview: (bounds: unknown) => ipcRenderer.invoke("git-preview:layout", bounds),
  reloadGitPreview: () => ipcRenderer.invoke("git-preview:reload"),
  loginGitPreview: (role: string) => ipcRenderer.invoke("git-preview:login", role),
  getPointEditor: () => ipcRenderer.invoke("point-editor:get"),
  enablePointEditor: (enabled: boolean) => ipcRenderer.invoke("point-editor:enable", enabled),
  changePointElement: (id: string, patch: unknown) => ipcRenderer.invoke("point-editor:change", id, patch),
  selectPointElement: (id: string) => ipcRenderer.invoke("point-editor:select", id),
  savePointEditor: () => ipcRenderer.invoke("point-editor:save"),
  discardPointEditor: () => ipcRenderer.invoke("point-editor:discard"),
  reloadPointEditor: () => ipcRenderer.invoke("point-editor:reload"),
  onPointEditorState: (callback: (state: unknown) => void) => { const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state); ipcRenderer.on("point-editor:state", handler); return () => ipcRenderer.removeListener("point-editor:state", handler); },
  onGitPreviewState: (callback: (state: unknown) => void) => { const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state); ipcRenderer.on("git-preview:state", handler); return () => ipcRenderer.removeListener("git-preview:state", handler); },
  getRemoteTarget: () => ipcRenderer.invoke("remote:get-target"),
  getRemoteState: () => ipcRenderer.invoke("remote:get-state"),
  getClientServer: (clientId: string, target?: unknown) => ipcRenderer.invoke("client-server:get", clientId, target),
  installationAccessRequest: (action: string, clientId: string, values?: unknown, revision?: number) => ipcRenderer.invoke("installation-access:request", action, clientId, values, revision),
  saveClientServer: (clientId: string, target: unknown, revision: number) => ipcRenderer.invoke("client-server:save", clientId, target, revision),
  toggleClientServerPassword: (clientId: string, target: unknown, password: string, revision: number, forget: boolean) => ipcRenderer.invoke("client-server:password", clientId, target, password, revision, forget),
  saveRemoteTarget: (target: unknown) => ipcRenderer.invoke("remote:save-target", target),
  probeRemoteTarget: (target: unknown) => ipcRenderer.invoke("remote:probe", target),
  inspectRemoteTarget: (target: unknown, credentials: unknown) => ipcRenderer.invoke("remote:inspect", target, credentials),
  preflightRemoteTarget: (target: unknown, credentials: unknown, clientId?: string) => ipcRenderer.invoke("remote:preflight", target, credentials, clientId),
  getDeploymentState: (clientId?: string) => ipcRenderer.invoke("deployment:get-state", clientId),
  getInstallationPlan: (clientId: string) => ipcRenderer.invoke("installation:get-plan", clientId),
  getInstallationState: (clientId: string) => ipcRenderer.invoke("installation:get-state", clientId),
  getUninstallation: (clientId: string) => ipcRenderer.invoke("uninstallation:get", clientId),
  recoverInstallation: (clientId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("installation:recover", clientId, target, credentials),
  onPackagePreparationProgress: (callback: (value: { snapshotId: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: { snapshotId: string; message: string }) => callback(value);
    ipcRenderer.on("installation:package-progress", handler); return () => ipcRenderer.removeListener("installation:package-progress", handler);
  },
  getClientDeletionPlan: (clientId: string) => ipcRenderer.invoke("client-deletion:plan", clientId),
  deleteClient: (clientId: string, target?: unknown, credentials?: unknown) => ipcRenderer.invoke("client-deletion:execute", clientId, target, credentials),
  onClientDeletionProgress: (callback: (state: { clientId: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: { clientId: string; message: string }) => callback(state);
    ipcRenderer.on("client-deletion:progress", handler);
    return () => ipcRenderer.removeListener("client-deletion:progress", handler);
  },
  prepareUninstallation: (clientId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("uninstallation:prepare", clientId, target, credentials),
  executeUninstallation: (clientId: string, operationId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("uninstallation:execute", clientId, operationId, target, credentials),
  refreshUninstallation: (clientId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("uninstallation:refresh", clientId, target, credentials),
  getSourceLibrary: () => ipcRenderer.invoke("source-library:get"),
  saveSourceLibraryEntry: (input: unknown, revision: number) => ipcRenderer.invoke("source-library:save", input, revision),
  getIpPublication: (clientId: string) => ipcRenderer.invoke("publication:get", clientId),
  getAiConfiguration: (clientId: string) => ipcRenderer.invoke("ai-configuration:get", clientId),
  configureLmsAi: (clientId: string, target: unknown, credentials: unknown, settings: unknown, checkOnly: boolean) => ipcRenderer.invoke("ai-configuration:execute", clientId, target, credentials, settings, checkOnly),
  provisionLmsAi: (clientId: string, target: unknown, credentials: unknown, settings: unknown) => ipcRenderer.invoke("ai-configuration:provision", clientId, target, credentials, settings),
  publishLmsIp: (clientId: string, target: unknown, credentials: unknown, checkOnly: boolean) => ipcRenderer.invoke("publication:execute", clientId, target, credentials, checkOnly),
  enableLmsIpHttps: (clientId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("publication:execute", clientId, target, credentials, false, true),
  getExecutionMode: () => ipcRenderer.invoke("execution:mode"),
  setExecutionMode: (mode: string) => ipcRenderer.invoke("execution:set-mode", mode),
  getServerPreparation: (clientId: string) => ipcRenderer.invoke("preparation:get", clientId),
  prepareCleanServer: (clientId: string, planId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("preparation:start", clientId, planId, target, credentials),
  prepareServerMemory: (clientId: string, planId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("preparation:memory", clientId, planId, target, credentials),
  refreshServerPreparation: (clientId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("preparation:refresh", clientId, target, credentials),
  onPreparationProgress: (callback: (state: unknown) => void) => { const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state); ipcRenderer.on("preparation:progress", handler); return () => ipcRenderer.removeListener("preparation:progress", handler); },
  openLmsViewer: (clientId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("viewer:open", clientId, target, credentials),
  closeLmsViewer: () => ipcRenderer.invoke("viewer:close"),
  layoutLmsViewer: (bounds: unknown) => ipcRenderer.invoke("viewer:layout", bounds),
  reloadLmsViewer: () => ipcRenderer.invoke("viewer:reload"),
  onLmsViewerState: (callback: (state: unknown) => void) => { const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state); ipcRenderer.on("viewer:state", handler); return () => ipcRenderer.removeListener("viewer:state", handler); },
  prepareInstallationPackage: (clientId: string, planId: string, snapshotId: string) => ipcRenderer.invoke("installation:package", clientId, planId, snapshotId),
  startInstallation: (clientId: string, planId: string, snapshotId: string, target: unknown, credentials: unknown, secrets: unknown) => ipcRenderer.invoke("installation:start", clientId, planId, snapshotId, target, credentials, secrets),
  refreshInstallation: (clientId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("installation:refresh", clientId, target, credentials),
  onInstallationProgress: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("installation:progress", handler); return () => ipcRenderer.removeListener("installation:progress", handler);
  },
  prepareInstallation: (clientId: string, snapshotId: string, target: unknown, contentMode: unknown) => ipcRenderer.invoke("installation:prepare", clientId, snapshotId, target, contentMode),
  checkInstallationServer: (clientId: string, planId: string, snapshotId: string, target: unknown, credentials: unknown) => ipcRenderer.invoke("installation:check-server", clientId, planId, snapshotId, target, credentials),
  deployRemoteTarget: (target: unknown, credentials: unknown, snapshotId: string, allowSwap: boolean, clientId?: string) => ipcRenderer.invoke("deployment:start", target, credentials, snapshotId, allowSwap, clientId),
  refreshDeployment: (target: unknown, credentials: unknown, clientId?: string) => ipcRenderer.invoke("deployment:refresh", target, credentials, clientId),
  onDeploymentProgress: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("deployment:progress", handler);
    return () => ipcRenderer.removeListener("deployment:progress", handler);
  },
  fetchSource: (config: unknown) => ipcRenderer.invoke("sources:fetch", config),
  onSourceProgress: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("sources:progress", handler);
    return () => ipcRenderer.removeListener("sources:progress", handler);
  },
  getStatuses: (options?: { fresh?: boolean }) => ipcRenderer.invoke("launcher:get-statuses", options),
  fetchJson: (url: string) => ipcRenderer.invoke("launcher:fetch-json", url),
  startService: (serviceId: string) => ipcRenderer.invoke("launcher:start-service", serviceId),
  stopService: (serviceId: string) => ipcRenderer.invoke("launcher:stop-service", serviceId),
  startAll: () => ipcRenderer.invoke("launcher:start-all"),
  stopAll: () => ipcRenderer.invoke("launcher:stop-all"),
  onOperationProgress: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on("launcher:operation-progress", handler);
    return () => ipcRenderer.removeListener("launcher:operation-progress", handler);
  },
  openUrl: (url: string) => ipcRenderer.invoke("launcher:open-url", url),
  openPgAdmin: () => ipcRenderer.invoke("launcher:open-pgadmin"),
  openFile: (filePath: string) => ipcRenderer.invoke("launcher:open-file", filePath),
  openConfig: () => ipcRenderer.invoke("launcher:open-config"),
  readLog: (filePath: string, options?: { fresh?: boolean }) => ipcRenderer.invoke("launcher:read-log", filePath, options),
  getMailConfiguration: (clientId: string) => ipcRenderer.invoke("mail-configuration:get", clientId),
  configureLmsMail: (clientId: string, target: unknown, credentials: unknown, action: string, settings?: unknown, recipient?: string) => ipcRenderer.invoke("mail-configuration:execute", clientId, target, credentials, action, settings, recipient),
  getPostgresSnapshot: (tableName?: string) =>
    ipcRenderer.invoke("launcher:get-postgres-snapshot", tableName),
  getLauncherLogPath: () => ipcRenderer.invoke("launcher:get-launcher-log-path")
});
