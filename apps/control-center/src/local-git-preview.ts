import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { InstallationPackageService } from "./installation-package";
import type { ClientDesignService } from "./client-design";
import { installationClient } from "./installation-client";

export type LocalGitPreviewState = { phase: "idle" | "preparing" | "building" | "starting" | "ready" | "stopping" | "stopped" | "failed"; clientId?: string; snapshotId?: string; revision?: string; repositoryUrl?: string; presentationMode?: "source" | "custom"; url?: string; message: string; code?: string };
type Admins = { clientAdminLogin: string; clientAdminPassword: string; systemAdminLogin: string; systemAdminPassword: string };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export class LocalGitPreviewService {
  private state: LocalGitPreviewState = { phase: "idle", message: "Запустите локальный просмотр выбранной Git-версии." };
  private worker?: ChildProcess;
  private ended?: Promise<void>;
  private admins?: Admins;
  private busy = false;
  constructor(private readonly root: string, private readonly packages: Pick<InstallationPackageService, "prepare" | "verify">,
    private readonly designs: Pick<ClientDesignService, "capture">,
    private readonly client: (id: string) => Promise<{ client: Record<string, unknown> }>,
    private readonly databaseUrl: () => Promise<string>,
    private readonly report: (state: LocalGitPreviewState) => void = () => {}) {}
  get() { return { ...this.state }; }
  private publish(value: Partial<LocalGitPreviewState>) { this.state = { ...this.state, ...value }; this.report(this.get()); }
  async start(clientId: string, source: { id: string; revision: string; repositoryUrl: string }, presentationMode: "source" | "custom" = "source") {
    if (this.busy || this.worker) throw Error("Сначала остановите текущий Git-просмотр.");
    if (!UUID.test(clientId) || !UUID.test(source.id) || !/^[a-f0-9]{40,64}$/.test(source.revision) || !["source", "custom"].includes(presentationMode)) throw Error("Выберите клиента и проверенную Git-версию.");
    this.busy = true;
    this.state = { phase: "preparing", clientId, snapshotId: source.id, revision: source.revision, repositoryUrl: source.repositoryUrl, presentationMode, message: "Готовлю локальный просмотр Git-LMS..." }; this.report(this.get());
    try {
      const detail = await this.client(clientId);
      if (detail.client.id !== clientId) throw Error("Клиент изменился. Повторите выбор.");
      const db = require(path.join(this.root, "packages/db/dist/src/index.js")) as { normalizeFreshClient: (value: unknown) => unknown };
      const client = installationClient(detail.client, db.normalizeFreshClient);
      // Legacy settings are retained, but are never mistaken for an explicit request to restyle Git UI.
      const design = presentationMode === "custom" ? await this.designs.capture(clientId) : undefined;
      const pkg = await this.packages.prepare(source.id, design);
      if (pkg.revision !== source.revision || (design ? pkg.design?.clientId !== clientId || pkg.design.sha256 !== design.sha256 : !!pkg.design)) throw Error("Пакет не соответствует выбранному клиенту, Git-версии или режиму оформления.");
      await this.packages.verify(pkg, source.id);
      const databaseUrl = await this.databaseUrl();
      const worker = spawn("node", [path.join(this.root, "infra/scripts/local-git-preview-worker.cjs")], { cwd: this.root, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: (require(path.join(this.root, "infra/scripts/runtime-process.cjs")) as { systemEnvironment: () => NodeJS.ProcessEnv }).systemEnvironment() });
      this.worker = worker; this.admins = undefined;
      this.ended = new Promise<void>((resolve) => {
        const finish = (exitCode?: unknown) => { if (this.worker === worker) { this.worker = undefined; this.admins = undefined; if (!["stopped", "failed"].includes(this.state.phase)) this.publish({ phase: "failed", url: undefined, code: typeof exitCode === "number" ? `PREVIEW_WORKER_EXIT_${exitCode}` : "PREVIEW_WORKER_START_FAILED", message: "Процесс просмотра завершился. Повторите локальный запуск." }); } resolve(); };
        worker.once("error", finish); worker.once("exit", finish);
      });
      worker.on("message", (value: unknown) => {
        if (this.worker !== worker || !value || typeof value !== "object") return;
        const item = value as { type?: string; admins?: Admins; phase?: string; message?: string; url?: string; code?: string };
        if (this.state.phase === "stopping" && !["stopped", "failed"].includes(item.phase || "")) return;
        if (item.type === "credentials") { this.admins = item.admins; return; }
        if (!["preparing", "building", "starting", "ready", "stopped", "failed"].includes(item.phase || "")) return;
        let url: string | undefined;
        if (item.phase === "ready") {
          try { const parsed = new URL(item.url!); if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/") return; url = parsed.origin; } catch { return; }
        }
        this.publish({ phase: item.phase as LocalGitPreviewState["phase"], message: String(item.message || "").slice(0, 500), url, code: item.code });
      });
      worker.send({ type: "start", input: { client, package: pkg, databaseUrl, presentationMode } });
      return this.get();
    } catch (error) { this.publish({ phase: "failed", url: undefined, message: error instanceof Error ? error.message : "Не удалось подготовить Git-просмотр." }); throw error; }
    finally { this.busy = false; }
  }
  async stop() {
    if (this.busy) throw Error("Подготовка пакета ещё выполняется. Дождитесь её завершения.");
    const worker = this.worker;
    if (!worker) return this.get();
    this.publish({ phase: "stopping", url: undefined, message: "Останавливаю просмотр и удаляю его тестовую БД..." });
    this.admins = undefined;
    if (worker.connected) worker.send({ type: "stop" });
    await this.ended;
    return this.get();
  }
  async login(role: unknown) {
    if (this.state.phase !== "ready" || !this.admins || !["admin", "system"].includes(String(role))) throw Error("Сначала дождитесь запуска Git-LMS.");
    const origin = this.state.url!;
    const login = role === "system" ? this.admins.systemAdminLogin : this.admins.clientAdminLogin;
    const password = role === "system" ? this.admins.systemAdminPassword : this.admins.clientAdminPassword;
    try {
      const response = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ login, password }), redirect: "error", signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error("LOGIN_FAILED");
      const cookie = response.headers.getSetCookie().find((value) => /^core_lms_session_[a-f0-9]+=/.test(value));
      if (!cookie) throw Error("COOKIE_MISSING");
      const [name, value] = cookie.split(";", 1)[0].split("=");
      return { url: origin, name, value, path: "/", httpOnly: true, sameSite: "lax" as const };
    } catch { throw Error("Не удалось войти в локальную тестовую учетную запись."); }
  }
}
