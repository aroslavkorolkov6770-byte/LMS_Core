import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { Credentials, RemoteTarget, RemoteTargetService } from "./remote-target";
import { NewDeploymentService } from "./new-deployment";
import { UninstallationService, UninstallationState } from "./uninstallation";

type Codec = { available(): boolean; encrypt(value: string): Buffer };
type Snapshot = { client: Record<string, any>; hash: string };
type Plan = { clientId: string; name: string; snapshotHash: string; database: string | null; target: RemoteTarget | null; jobId?: string; releaseId?: string; appPath?: string; webPort?: number };
type Store = { clientSnapshot(sql: any, id: string): Promise<Snapshot>; finalizeClientDeletion(sql: any, input: unknown, archive: (value: unknown) => Promise<string>): Promise<any>;
  privateArchive(root: string, operationId: string, value: unknown, codec: Codec): Promise<string> };

export class ClientDeletionService {
  private busy = false;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">,
    private readonly deployments: Pick<NewDeploymentService, "get">, private readonly removal: Pick<UninstallationService, "get" | "prepare" | "execute" | "accepted">,
    private readonly url: () => Promise<string>, private readonly codec: Codec, private readonly allowed: (target: RemoteTarget) => Promise<boolean>) {}
  private store(): Store { return require(path.join(this.root, "infra/scripts/core-client-delete.cjs")); }
  private async core<T>(work: (sql: any) => Promise<T>): Promise<T> {
    const url = new URL(await this.url());
    if (process.platform !== "win32" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "55432" || url.pathname !== "/lms_core") throw Error("Удаление поддержано только для локальной управляющей БД Core, не для произвольного PostgreSQL.");
    const postgres = createRequire(path.join(this.root, "packages/db/package.json"))("postgres");
    const sql = postgres(url.href, { max: 1, connect_timeout: 5, onnotice: () => {} });
    try {
      const [identity] = await sql.unsafe("SELECT current_database() AS database,inet_server_port() AS port,current_setting('data_directory') AS directory");
      if (identity.database !== "lms_core" || identity.port !== 55432 || path.resolve(identity.directory).toLowerCase() !== path.resolve(this.root, "infra/local-postgres/data").toLowerCase()) throw Error("БД ядра не опознана; удаление запрещено.");
      return await work(sql);
    } finally { await sql.end({ timeout: 5 }); }
  }
  async plan(clientId: string): Promise<Plan> {
    const snapshot = await this.core(sql => this.store().clientSnapshot(sql, clientId));
    const installed = await this.deployments.get(clientId, true);
    if (!installed) {
      // A missing record is a draft; a broken record must never masquerade as a draft.
      try { await lstat(path.join(this.root, "infra/runtime/new-deployments", clientId + ".json")); throw Error("Есть нечитаемая установка. Сначала восстановите ее учет."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const profiles = await this.core<any[]>(async sql => await sql.unsafe("SELECT status FROM public.deploy_profiles WHERE client_id=$1::uuid", [clientId]));
      if (profiles[0]?.status === "deployed") throw Error("Клиент отмечен развернутым, но подтвержденного учета установки нет. Карточка сохранена; сначала восстановите связь с LMS.");
      return { clientId, name: String(snapshot.client.name), snapshotHash: snapshot.hash, database: null, target: null };
    }
    if (installed.phase !== "succeeded") throw Error("Есть незавершенная установка. Сначала проверьте ее результат; удаление карточки заблокировано.");
    if (!await this.allowed(installed.target)) throw Error("Внешние операции выключены. Разрешите выбранный сервер в настройках Core.");
    return { clientId, name: String(snapshot.client.name), snapshotHash: snapshot.hash, target: installed.target, database: "lms_" + clientId.replaceAll("-", ""),
      jobId: installed.id, releaseId: installed.releaseId, appPath: installed.target.appPath, webPort: installed.webPort };
  }
  private async script(input: unknown, action: string, archived: boolean) {
    const source = await readFile(path.join(this.root, "infra/scripts/delete-client-database.cjs"), "utf8");
    const vault = await readFile(path.join(this.root, "infra/scripts/runtime-process.cjs"), "utf8");
    return `const vault=(()=>{const module={exports:{}};const exports=module.exports;${vault}\nreturn module.exports;})();\nconst worker=(()=>{const module={exports:{}};const exports=module.exports;${source}\nreturn module.exports;})();\nworker.${action}(${JSON.stringify(input)},{unseal:vault.openSecrets,agreement:true,archived:${archived}}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>process.stdout.write(JSON.stringify({errorCode:/^[A-Z_]{1,80}$/.test(e.code||'')?e.code:'CLIENT_DATABASE_DELETE_FAILED'})));`;
  }
  private async remoteCommand(plan: Plan, removal: UninstallationState | null, auth: Credentials, execute: boolean) {
    const input = { clientId: plan.clientId, jobId: plan.jobId, releaseId: plan.releaseId, operationId: removal?.operationId || randomUUID(), appPath: plan.appPath };
    const script = await this.script(input, execute ? "deleteArchivedDatabase" : "checkClientDatabase", removal?.phase === "uninstalled");
    const raw = JSON.parse(await this.remote.withSession(plan.target!, { ...auth }, session => session.execute("node -", script, 120000)));
    if (raw.errorCode || raw.database !== plan.database || execute && raw.databaseDeleted !== true) throw Error(`БД не удалена или результат не подтвержден: ${raw.errorCode || "CLIENT_DATABASE_RESULT_INVALID"}. Карточка клиента сохранена.`);
    return raw;
  }
  async accepted(): Promise<boolean> {
    try {
      const gate = JSON.parse(await readFile(path.join(this.root, "infra/runtime/client-deletion-acceptance.json"), "utf8"));
      const bytes = await readFile(path.join(this.root, "infra/scripts/delete-client-database.cjs"));
      return gate.version === 1 && gate.accepted === true && gate.databaseDrop === true && gate.otherDatabasePreserved === true && gate.fixtureCleaned === true && gate.foreignMarkerRejected === true && gate.retryAccepted === true && gate.workerSha256 === createHash("sha256").update(bytes).digest("hex");
    } catch { return false; }
  }
  async execute(clientId: string, auth: Credentials | null, confirm: (plan: Plan) => Promise<boolean>, progress: (message: string) => void) {
    if (this.busy) throw Error("Удаление клиента уже выполняется.");
    this.busy = true;
    try {
      if (!this.codec.available()) throw Error("Защищенный архив Windows недоступен. Удаление запрещено.");
      const plan = await this.plan(clientId);
      if (plan.target && (!await this.accepted() || !await this.removal.accepted())) throw Error("Сначала нужна актуальная локальная Linux-проверка удаления и восстановления БД.");
      if (!await confirm(plan)) return { phase: "cancelled", clientId };
      if (JSON.stringify(await this.plan(clientId)) !== JSON.stringify(plan)) throw Error("Клиент или установка изменились. Повторите проверку.");
      let proof: Record<string, unknown> = { neverInstalled: true };
      if (plan.target) {
        if (!auth) throw Error("Откройте Репозиторий, выберите сервер клиента и введите SSH-пароль либо сохраните его замком. Затем повторите удаление.");
        let removal = await this.removal.get(clientId);
        if (removal && (removal.jobId !== plan.jobId || removal.releaseId !== plan.releaseId)) removal = null;
        if (removal?.phase !== "uninstalled") {
          progress("Проверяю принадлежность БД и возможность удаления...");
          await this.remoteCommand(plan, null, auth, false);
          removal = await this.removal.prepare(clientId, plan.target, { ...auth });
          progress("Останавливаю только LMS клиента, создаю и проверяю резервную копию...");
          removal = await this.removal.execute(clientId, removal.operationId, plan.target, { ...auth });
          if (removal.phase !== "uninstalled") throw Error("Архивирование LMS не завершено. Карточка и БД не удалены; проверьте результат удаления LMS.");
        }
        progress("Резервная копия готова. Удаляю выделенную БД клиента...");
        proof = await this.remoteCommand(plan, removal, auth, true);
      }
      progress("Удаляю карточку и локальные данные клиента, сохраняю журнал операции...");
      const operationId = randomUUID(), store = this.store();
      const result = await this.core(sql => store.finalizeClientDeletion(sql, { clientId, operationId, snapshotHash: plan.snapshotHash, proof }, value => store.privateArchive(this.root, operationId, value, this.codec)));
      const journal = path.join(this.root, "infra/runtime/client-deletions");
      await mkdir(journal, { recursive: true });
      const file = path.join(journal, clientId + ".json"), tmp = file + "." + operationId + ".tmp";
      try { await writeFile(tmp, JSON.stringify(result), { flag: "wx", mode: 0o600 }); await rename(tmp, file); }
      catch { /* The committed SQL audit is authoritative if the optional UI receipt cannot be saved. */ }
      return result;
    } finally { this.busy = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
}
