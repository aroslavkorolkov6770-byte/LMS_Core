import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { InstallationPackageService } from "./installation-package";
import { NewInstallationPlan, NewInstallationService } from "./new-installation";
import { Credentials, normalizeRemoteTarget, RemoteTarget, RemoteTargetService, RemoteSession } from "./remote-target";
import { assertInstallationConfiguration } from "./installation-client";

const messages: Record<string, string> = { preparing: "Проверяю план и пакет...", connecting: "Подключаюсь к выбранной SSH-цели...", uploading: "Передаю пакет без данных пилота...",
  starting: "Запускаю отдельное задание...", verifying: "Проверяю архив перед распаковкой...", extracting: "Распаковываю проверенный пакет...", validate: "Проверяю новый путь и порты...",
  reserve: "Создаю отдельного пользователя и каталоги...", build: "Устанавливаю зависимости и собираю LMS...", initialize: "Создаю выделенную базу и схему...", bootstrap: "Создаю администраторов и выбранную учебную базу...",
  configure: "Сохраняю защищённую конфигурацию...", activate: "Запускаю отдельные службы...", health: "Проверяю LMS, базу и учебные материалы...", commit: "Сохраняю результат...",
  succeeded: "LMS установлена; службы и база отвечают.", failed: "Установка не выполнена. Смотрите этап и код ошибки.", needs_attention: "Установка остановлена. Core сохранил созданные ресурсы, чтобы не потерять данные. Ниже указаны причина и доступное действие.",
  disconnected: "Наблюдение прервано; задание могло продолжиться. Сначала проверьте результат." };
const terminal = new Set(["succeeded", "failed", "needs_attention"]);
const databaseErrors: Record<string, string> = {
  CURRICULUM_INSTALL_VERIFY_FAILED: "Учебное наполнение не совпало с выбранным пакетом. Успех установки не подтвержден; существующие данные автоматически не удаляются.",
  CURRICULUM_INSTALL_CONNECTION_FAILED: "Прервалась проверка учебных материалов через приватный API. Проверьте результат задания; повторная установка не запускается автоматически.",
  JOB_CONTENT_MODE_MISMATCH: "Режим материалов задания не совпал с пакетом. Сервер не должен использовать другой вариант наполнения.",
  INSTALL_SSH_CONNECT_FAILED: "Не удалось завершить SSH-подключение перед установкой. Новая LMS не создавалась; проверьте доступность сервера и повторите запуск.",
  INSTALL_DATABASE_CHECK_FAILED: "Прервалась служебная проверка PostgreSQL перед загрузкой пакета. Новая LMS не создавалась; повторите проверку сервера и запуск. При повторении проверьте нагрузку и SSH-связь.",
  INSTALL_JOB_SETUP_FAILED: "Не удалось подготовить защищенный служебный каталог задания. Сборка и создание БД еще не запускались; нужна проверка прав и пути /srv/lms-core/jobs.",
  INSTALL_PACKAGE_UPLOAD_FAILED: "Передача пакета прервалась до запуска установки. Сборка и создание БД не запускались; проверьте связь и повторите запуск.",
  INSTALL_NAMESPACE_RETRY_READY: "Установка остановилась до создания ресурсов клиента. Отсутствие БД, аккаунта и каталога подтверждено; можно повторить запуск без удаления данных и пересборки пакета.",
  DATABASE_ADMIN_CONNECTION_FAILED: "Не удалось подключиться к PostgreSQL по указанным реквизитам. Если БД на этом же сервере, выберите «На этом сервере — автоматически, без пароля postgres». Пароль SSH и пароль PostgreSQL — разные данные.",
  DATABASE_LOCAL_PEER_UNAVAILABLE: "Локальный PostgreSQL пока недоступен через служебную учетку postgres. Подготовьте окружение сервера; его SSH-доступ работает.",
  DATABASE_PROVISION_ADMIN_REQUIRED: "Указанный пользователь PostgreSQL не имеет прав создавать отдельную БД и SQL-роль клиента.",
  DATABASE_ADMIN_CONFIG_INVALID: "Некорректны реквизиты административного подключения к PostgreSQL.",
  DATABASE_PROVISION_CONFLICT: "БД или SQL-роль с этим именем уже существуют и не принадлежат текущему заданию. Core их не перезаписывает.",
  DATABASE_PROVISION_UNCONFIRMED: "Не удалось подтвердить создание БД. Сайт не запущен; нужно определить, остались ли ресурсы этого задания.",
  INSTALLATION_RETRY_READY: "Неудачная подготовка архивирована, БД не создавалась. Выберите автоматический PostgreSQL на этом сервере и повторите установку."
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type NewDeploymentState = { id: string; clientId: string; planId: string; releaseId: string; snapshotId: string; revision: string; target: RemoteTarget;
  phase: string; message: string; updatedAt: string; webPort: number; apiPort: number; errorCode?: string; failedStep?: string; retryAvailable?: boolean };
export type NewInstallInput = { maintenanceUrl?: string; databaseMode?: "local_peer"; clientAdminLogin: string; clientAdminName: string; clientAdminPassword: string; systemAdminLogin: string; systemAdminPassword: string };
type SecretCodec = { available(): boolean; encrypt(plain: string): Buffer };

export function assertNewInstallationReady(plan: NewInstallationPlan | null, planId: string, target: RemoteTarget, client: Record<string, unknown>, now = Date.now()): asserts plan is NewInstallationPlan & {
  package: NonNullable<NewInstallationPlan["package"]>; preflight: NonNullable<NewInstallationPlan["preflight"]>;
} {
  if (!plan || plan.id !== planId || !target.fingerprint || client.id !== plan.client.id || client.slug !== plan.client.slug ||
    ["host", "port", "username", "basePath", "fingerprint"].some((key) => target[key as keyof RemoteTarget] !== plan.target[key as keyof RemoteTarget])) {
    throw Error("Клиент, план или SSH-параметры изменились. Подготовьте новый план для выбранной цели.");
  }
  assertInstallationConfiguration(plan.clientConfiguration, client);
  if (!["empty", "source"].includes(plan.contentMode || "") || plan.package && (plan.package.contentMode ?? "empty") !== plan.contentMode) throw Error("Наполнение LMS не выбрано или не совпадает с пакетом. Подготовьте план с явным выбором материалов.");
  if (plan.contentMode === "source" && (!plan.package?.curriculum || plan.package.curriculum.revision !== plan.source.revision || !/^[a-f0-9]{64}$/.test(plan.package.curriculum.sha256))) throw Error("Учебные материалы пакета не подтверждены для выбранного Git. Соберите пакет заново; сервер не изменен.");
  if (!plan.package) throw Error("Пакет LMS не подготовлен. Нажмите «2. Собрать пакет».");
  // A stale server check does not invalidate the immutable local plan or package.
  const age = now - Date.parse(plan.preflight?.checkedAt || "");
  if (!Number.isFinite(age) || age < 0 || age > 10 * 60 * 1000) {
    throw Error("Проверка сервера отсутствует или истекла (срок 10 минут). Нажмите только «3. Проверить сервер», затем повторите установку. План и пакет пересоздавать не нужно.");
  }
  if (plan.status !== "prepared") throw Error("Не все условия установки выполнены. Посмотрите список проверок в плане; сервер не изменён.");
}

function parseStatus(text: string, state: NewDeploymentState): Partial<NewDeploymentState> {
  const value = JSON.parse(text);
  if (value.id !== state.id || value.clientId !== state.clientId || value.releaseId !== state.releaseId || !Object.hasOwn(messages, value.phase) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw Error("INSTALL_STATUS_MISMATCH");
  const result: Partial<NewDeploymentState> = { phase: value.phase, message: messages[value.phase], updatedAt: value.updatedAt, errorCode: undefined, failedStep: undefined };
  for (const key of ["errorCode", "failedStep"] as const) if (typeof value[key] === "string" && /^[A-Za-z0-9_]{1,100}$/.test(value[key])) result[key] = value[key];
  if (result.errorCode && databaseErrors[result.errorCode]) result.message = databaseErrors[result.errorCode];
  result.retryAvailable = value.retryAvailable === true;
  if (result.retryAvailable) result.message = result.failedStep === "bootstrap"
    ? "Доступно продолжение установки без удаления БД и повторного создания администраторов. Нажмите «Восстановить запуск»."
    : "Установка остановилась до создания БД. Доступно безопасное восстановление запуска: собственная неудачная папка будет архивирована, данные БД не удаляются.";
  return result;
}

export class NewDeploymentService {
  private active = false;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">,
    private readonly plans: Pick<NewInstallationService, "get">, private readonly packages: Pick<InstallationPackageService, "verify">,
    private readonly codec: SecretCodec, private readonly pause = () => new Promise((resolve) => setTimeout(resolve, 3000)),
    private readonly targetAllowed = async (target: RemoteTarget) => ["127.0.0.1", "localhost"].includes(target.host),
    private readonly currentDesignHash?: (clientId: string, version?: number, sourceRevision?: string) => Promise<string>) {}
  private file(clientId: string) {
    if (!UUID.test(clientId)) throw Error("Некорректный клиент задания.");
    return path.join(this.root, "infra/runtime/new-deployments", `${clientId}.json`);
  }
  async get(clientId: string, includeRemoved = false): Promise<NewDeploymentState | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(clientId), "utf8")) as NewDeploymentState;
      if (!UUID.test(raw.id) || !UUID.test(raw.releaseId) || !UUID.test(raw.planId) || raw.clientId !== clientId || !UUID.test(raw.snapshotId) ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(raw.revision) || !Object.hasOwn(messages, raw.phase) ||
        ![raw.apiPort, raw.webPort].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535)) return null;
      const state: NewDeploymentState = { id: raw.id, clientId, planId: raw.planId, releaseId: raw.releaseId, snapshotId: raw.snapshotId, revision: raw.revision,
        target: normalizeRemoteTarget(raw.target), phase: raw.phase, message: messages[raw.phase], updatedAt: raw.updatedAt, webPort: raw.webPort, apiPort: raw.apiPort };
      Object.assign(state, parseStatus(JSON.stringify(raw), state));
      let fullRemovalApplies = false;
      try {
        const full = JSON.parse(await readFile(path.join(this.root, "infra/runtime/full-uninstallations", `${clientId}.json`), "utf8"));
        if (full.version !== 2 || full.mode !== "full" || full.preserveData !== false || full.clientId !== clientId || !UUID.test(full.operationId)) throw Error("FULL_REMOVAL_RECORD_INVALID");
        if (full.jobId === state.id && full.releaseId === state.releaseId && full.appPath === state.target.appPath && full.target?.host === state.target.host && full.database === "lms_" + clientId.replaceAll("-", "")) {
          fullRemovalApplies = true;
          if (!includeRemoved && full.phase === "uninstalled" && full.databaseDeleted === true && full.serviceAccountDeleted === true && full.certificatesArchived === true) return null;
          if (!includeRemoved && full.archiveCompleted) { state.phase = "needs_attention"; state.message = "LMS архивирована, полное удаление еще не подтверждено. Завершите удаление БД/служебной учетки перед новой установкой."; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !includeRemoved) { fullRemovalApplies = true; state.phase = "needs_attention"; state.message = "Учет полного удаления не прочитан. Проверьте его результат до новой установки."; } }
      try {
        const removal = JSON.parse(await readFile(path.join(this.root, "infra/runtime/uninstallations", `${clientId}.json`), "utf8"));
        if (removal.version === 1 && removal.clientId === clientId && removal.jobId === state.id && removal.releaseId === state.releaseId &&
          UUID.test(removal.operationId) && removal.appPath === state.target.appPath && removal.phase === "uninstalled" && removal.preserveData === true &&
          removal.backupPath === `/srv/lms-core/backups/${clientId}/${removal.operationId}` && !includeRemoved && !fullRemovalApplies) return null;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { state.phase = "needs_attention"; state.message = "Учет удаления не прочитан. Перепроверьте состояние, не запускайте новую установку."; } }
      if (!this.active && !terminal.has(state.phase)) { state.phase = "disconnected"; state.message = messages.disconnected; }
      return state;
    } catch { return null; }
  }
  private async save(state: NewDeploymentState, report: (value: NewDeploymentState) => void) {
    const file = this.file(state.clientId); await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 }); await rename(temporary, file);
    try { report({ ...state }); } catch { /* Closing a renderer must not stop an installation. */ }
  }
  private async recoveryScript(state: NewDeploymentState, execute: boolean): Promise<string> {
    const source = await readFile(path.join(this.root, "infra/scripts/recover-failed-installation.cjs"), "utf8");
    if (execute) {
      const gate = JSON.parse(await readFile(path.join(this.root, "infra/runtime/recovery-acceptance.json"), "utf8"));
      if (!gate.accepted || !gate.realLinuxAccount || !gate.fixtureCleaned || gate.workerSha256 !== createHash("sha256").update(source).digest("hex")) throw Error("Сначала нужна актуальная локальная Linux-проверка восстановления установки.");
    }
    const input = { clientId: state.clientId, jobId: state.id, releaseId: state.releaseId, appPath: state.target.appPath };
    return `const recovery=(()=>{const module={exports:{}};const exports=module.exports;${source}\nreturn module.exports;})();recovery.${execute ? "recoverFailedInstallation" : "inspectRecovery"}(${JSON.stringify(input)},{agreement:${execute}}).then(r=>process.stdout.write(JSON.stringify({clientId:${JSON.stringify(state.clientId)},jobId:${JSON.stringify(state.id)},phase:r.phase,retryAvailable:true}))).catch(e=>process.stdout.write(JSON.stringify({retryAvailable:false,errorCode:/^[A-Z_]{1,80}$/.test(e.code||'')?e.code:'RECOVERY_UNCONFIRMED'})));`;
  }
  private async bootstrapResumeScript(state: NewDeploymentState, execute: boolean): Promise<string> {
    const modules: Record<string, string> = {};
    for (const name of ["resume-lms-installation.cjs", "lms-new-install-worker.cjs", "runtime-process.cjs", "source-curriculum.cjs"]) modules["./" + name] = await readFile(path.join(this.root, "infra/scripts", name), "utf8");
    if (execute) {
      const gate = JSON.parse(await readFile(path.join(this.root, "infra/runtime/bootstrap-resume-acceptance.json"), "utf8"));
      if (gate.accepted !== true || gate.fixtureCleaned !== true || !["empty", "source"].every(mode => gate.results?.some((r: Record<string, unknown>) => r.mode === mode && r.realPostgres && r.realApi && r.realSystemd && r.vaultPreserved && r.accountsPreserved && r.curriculumVerified)) ||
        Object.entries(modules).some(([name, source]) => gate.dependencies?.[name.slice(2)] !== createHash("sha256").update(source).digest("hex"))) throw Error("Продолжение установки ещё не принято на текущей версии Linux-установщика; данные сохранены.");
    }
    const input = { clientId: state.clientId, jobId: state.id, releaseId: state.releaseId, appPath: state.target.appPath };
    return `const sources=${JSON.stringify(modules)},cache={};function load(name){if(!sources[name])return require(name);if(cache[name])return cache[name].exports;const m={exports:{}};cache[name]=m;new Function('require','module','exports',sources[name])(load,m,m.exports);return m.exports;}load('./resume-lms-installation.cjs').resumeBootstrappedInstallation(${JSON.stringify(input)},{inspect:${!execute}}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>process.stdout.write(JSON.stringify({resumeAvailable:false,errorCode:/^[A-Z_]{1,80}$/.test(e.code||e.message||'')?e.code||e.message:'INSTALL_RESUME_UNCONFIRMED'})));`;
  }
  private async diagnoseRetry(state: NewDeploymentState, session: RemoteSession): Promise<void> {
    if (state.phase === "needs_attention" && state.failedStep === "bootstrap" && state.errorCode === "CURRICULUM_INSTALL_VERIFY_FAILED") {
      try {
        const result = JSON.parse(await session.execute("node -", await this.bootstrapResumeScript(state, false), 45000));
        state.retryAvailable = result.resumeAvailable === true && result.clientId === state.clientId && result.jobId === state.id && result.releaseId === state.releaseId;
        if (state.retryAvailable) state.message = "Нажмите «Восстановить запуск»: Core продолжит существующую установку, сохранив БД, ключи и администраторов. Повторно вводить их пароли не нужно.";
      } catch { state.retryAvailable = false; }
      return;
    }
    if (state.phase === "needs_attention" && state.failedStep === "reserve" && state.errorCode === "NAMESPACE_NOT_TRAVERSABLE") {
      try {
        const source = await readFile(path.join(this.root, "infra/scripts/inspect-empty-installation.cjs"), "utf8");
        const input = { clientId: state.clientId, jobId: state.id, releaseId: state.releaseId, appPath: state.target.appPath };
        const script = `const check=(()=>{const module={exports:{}};${source}\nreturn module.exports;})();check.inspectEmptyInstallation(${JSON.stringify(input)}).then(r=>process.stdout.write(JSON.stringify(r))).catch(()=>process.stdout.write(JSON.stringify({empty:false})));`;
        const result = JSON.parse(await session.execute("node -", script, 30000));
        if (result.empty === true && result.clientId === state.clientId && result.jobId === state.id && result.releaseId === state.releaseId) {
          Object.assign(state, { phase: "failed", errorCode: "INSTALL_NAMESPACE_RETRY_READY", message: databaseErrors.INSTALL_NAMESPACE_RETRY_READY, retryAvailable: false });
        }
      } catch { /* An unconfirmed absence must never unlock another installation. */ }
      return;
    }
    if (state.phase !== "needs_attention" || state.failedStep !== "initialize") return;
    try {
      const result = JSON.parse(await session.execute("node -", await this.recoveryScript(state, false), 30000));
      state.retryAvailable = result.retryAvailable === true && result.clientId === state.clientId && result.jobId === state.id;
      if (state.retryAvailable) state.message = "Установка остановилась до создания БД. Нажмите «Восстановить запуск»; Core архивирует только собственную неудачную подготовку. Данные БД не удаляются.";
      else if (result.errorCode === "RECOVERY_DATABASE_EXISTS_REQUIRES_RESUME") state.message = "Найдены SQL-объекты клиента. Core сохранил их и заблокировал новую установку, чтобы не перезаписать данные. Нужен режим продолжения существующего задания, не создание новой БД.";
    } catch { state.retryAvailable = false; }
  }
  async recover(clientId: string, input: unknown, auth: Credentials, report: (value: NewDeploymentState) => void) {
    if (this.active) throw Error("Дождитесь завершения текущей операции."); this.active = true;
    try {
      const state = await this.get(clientId), target = normalizeRemoteTarget(input);
      if (!state || state.phase !== "needs_attention" || !["initialize", "bootstrap"].includes(state.failedStep || "") || ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof RemoteTarget] !== state.target[key as keyof RemoteTarget]) || !await this.targetAllowed(state.target)) throw Error("Выберите точное остановленное задание и его сервер. Слепой повтор запрещен.");
      if (state.failedStep === "bootstrap") {
        if (state.errorCode !== "CURRICULUM_INSTALL_VERIFY_FAILED") throw Error("Для этого этапа пока нет подтвержденного сценария продолжения. Данные сохранены.");
        const result = await this.remote.withSession(state.target, auth, session => this.bootstrapResumeScript(state, true).then(script => session.execute("node -", script, 180000)));
        const parsed = parseStatus(result, state); Object.assign(state, parsed);
        if (parsed.phase === "succeeded") await unlink(path.join(path.dirname(this.file(clientId)), `${state.id}.db-secret.bin`)).catch(() => { /* A leftover OS-encrypted secret never changes a confirmed remote success. */ });
        await this.save(state, report); return state;
      }
      const script = await this.recoveryScript(state, true);
      const result = JSON.parse(await this.remote.withSession(state.target, auth, session => session.execute("node -", script, 120000)));
      if (!result.retryAvailable || result.jobId !== state.id || result.clientId !== clientId) throw Error(`Восстановление не подтверждено: ${result.errorCode || "RECOVERY_UNCONFIRMED"}. Существующие БД не удаляются.`);
      Object.assign(state, { phase: "failed", retryAvailable: false, errorCode: "INSTALLATION_RETRY_READY", message: databaseErrors.INSTALLATION_RETRY_READY, updatedAt: new Date().toISOString() });
      await this.save(state, report); return state;
    } finally { this.active = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
  async start(clientId: string, planId: string, targetInput: unknown, auth: Credentials, input: NewInstallInput, client: Record<string, unknown>, report: (value: NewDeploymentState) => void) {
    if (this.active) throw Error("Установка уже выполняется.");
    this.active = true;
    let state: NewDeploymentState | undefined, launched = false, preparationStep = "ssh_connect";
    try {
      const old = await this.get(clientId);
      if (old && old.phase !== "failed") throw Error("У клиента уже есть задание. Проверьте его результат; повторная установка не допускается.");
      const plan = await this.plans.get(clientId), target = normalizeRemoteTarget(targetInput);
      if (client.id !== clientId) throw Error("Клиент установки изменился. Выберите нужного клиента заново.");
      assertNewInstallationReady(plan, planId, target, client);
      if (input.clientAdminLogin !== plan.admins.clientLogin || input.systemAdminLogin !== plan.admins.systemLogin) throw Error("Логины администраторов изменились после подготовки плана. Перечитайте карточку и подготовьте план заново; сервер не изменен.");
      if (input.databaseMode === "local_peer" && ["missing", "unavailable"].includes(plan.preflight.postgresState || "")) {
        throw Error(plan.preflight.postgresState === "missing" ? "PostgreSQL не установлена. На шаге «Подготовка» нажмите «Подготовить чистую Ubuntu», затем «Проверить сервер». План и пакет пересобирать не нужно." : "Служебный доступ к PostgreSQL не подтвержден. Проверьте существующую БД либо укажите административные реквизиты; пароли автоматически не сбрасываются.");
      }
      // Local acceptance is explicitly allowed; a real host stays blocked until the Linux gate is documented.
      if (!await this.targetAllowed(target)) throw Error("Включен локальный режим. Внешние серверы заблокированы в настройках Core.");
      if (!this.codec.available()) throw Error("Защищённое хранилище ОС недоступно; пароль базы не будет сохранён открытым текстом.");
      const pkg = await this.packages.verify(plan.package, plan.source.snapshotId);
      if ((pkg.contentMode ?? "empty") !== plan.contentMode) throw Error("Режим наполнения проверенного пакета изменился; установка не запускалась.");
      const personalized = Boolean(plan.designRequired || plan.design || pkg.design);
      if (personalized && !["custom", "point"].includes(plan.presentationMode || "") || plan.presentationReviewRequired || plan.presentationMode === "point" && pkg.design?.version !== 3) throw Error("План содержит старое оформление. Пересоздайте его с исходным Git-видом.");
      if (personalized && (!plan.design || pkg.design?.clientId !== clientId || pkg.design.sha256 !== plan.design.sha256 || this.currentDesignHash && await this.currentDesignHash(clientId, plan.design.version, plan.source.revision) !== plan.design.sha256)) throw Error("Оформление клиента изменилось или пакет принадлежит другому клиенту. Пересоздайте план и пакет перед установкой.");
      const workerModule = require(path.join(this.root, "infra/scripts/lms-new-install-worker.cjs")) as { validateSecrets: (value: unknown) => unknown };
      const secrets = { ...input, databasePassword: randomBytes(32).toString("base64url") };
      workerModule.validateSecrets(secrets);
      state = { id: randomUUID(), clientId, planId, snapshotId: plan.source.snapshotId, releaseId: pkg.id, revision: pkg.revision, target: plan.target,
        phase: "preparing", message: messages.preparing, updatedAt: new Date().toISOString(), apiPort: plan.preflight.apiPort!, webPort: plan.preflight.candidatePort! };
      const current = state;
      const progress = async (extra: Partial<NewDeploymentState>) => { Object.assign(current, extra); await this.save(current, report); };
      await progress({});
      const secretFile = path.join(path.dirname(this.file(clientId)), `${current.id}.db-secret.bin`);
      await writeFile(secretFile, this.codec.encrypt(JSON.stringify({ clientId, jobId: current.id, databasePassword: secrets.databasePassword })), { flag: "wx", mode: 0o600 });
      await progress({ phase: "connecting", message: messages.connecting });
      return await this.remote.withSession(plan.target, auth, async (session) => {
        preparationStep = "database_check";
        // Read-only database access check precedes upload, build and any remote resource creation.
        const preflightSource = await readFile(path.join(this.root, "infra/scripts/database-preflight.cjs"), "utf8");
        const preflightScript = `const probe=(()=>{const module={exports:{}};const exports=module.exports;${preflightSource}\nreturn module.exports;})();let raw='';process.stdin.on('data',c=>{raw+=c;if(Buffer.byteLength(raw)>16384)process.exit(1)});process.stdin.on('end',()=>{try{probe.checkDatabaseAccess(JSON.parse(raw)).then(r=>process.stdout.write(JSON.stringify(r)))}catch{process.exitCode=1}});`;
        const preflightCommand = `node -e "eval(Buffer.from('${Buffer.from(preflightScript).toString("base64")}','base64').toString())"`;
        const access = JSON.parse(await session.execute(preflightCommand, JSON.stringify(input.databaseMode === "local_peer" ? { databaseMode: "local_peer" } : { maintenanceUrl: input.maintenanceUrl }), 20000));
        if (access.ready !== true) {
          const code = Object.hasOwn(databaseErrors, access.errorCode) ? access.errorCode : "DATABASE_ADMIN_CONNECTION_FAILED";
          throw Object.assign(Error(databaseErrors[code]), { code });
        }
        preparationStep = "job_setup";
        const dir = `/srv/lms-core/jobs/${current.id}`;
        const bootstrap: Record<string, string> = {};
        for (const name of ["lms-install-job.cjs", "lms-new-install-worker.cjs", "runtime-process.cjs", "source-curriculum.cjs", ...(pkg.design ? ["client-design-contract.cjs"] : []), ...(pkg.design?.version === 3 ? ["point-design-contract.cjs"] : [])]) bootstrap[name] = (await readFile(path.join(this.root, "infra/scripts", name))).toString("base64");
        const job = { version: pkg.design ? 2 : 1, id: current.id, releaseId: pkg.id, client, apiPort: current.apiPort, webPort: current.webPort, contentMode: plan.contentMode, ...(pkg.design ? { designSha256: pkg.design.sha256 } : {}) };
        const setup = `const fs=require('node:fs');process.umask(0o077);if(process.platform!=='linux'||process.getuid()!==0)process.exit(1);
const allowTenantTraversal=p=>{const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))process.exit(1);if(!(s.mode&0o001)){for(const name of fs.readdirSync(p)){const child=fs.lstatSync(p+'/'+name);if(child.uid!==0||child.isSymbolicLink()||(child.mode&0o022)||!child.isDirectory()&&(child.mode&0o077))process.exit(1);}fs.chmodSync(p,(s.mode&0o777)|0o011);}};
let p='';for(const part of '${dir}'.split('/').filter(Boolean)){p+='/'+part;if(!fs.existsSync(p))fs.mkdirSync(p,{mode:p==='/srv/lms-core'?0o755:0o700});const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))process.exit(1);
// Legacy Core used 0700 on this shared parent. Allow traversal only, never directory listing or secret-file reads.
if(p==='/srv/lms-core')allowTenantTraversal(p);}if(fs.existsSync('/srv/lms-core/clients'))allowTenantTraversal('/srv/lms-core/clients');fs.chmodSync('${dir}',0o700);
for(const [name,value] of Object.entries(${JSON.stringify(bootstrap)}))fs.writeFileSync('${dir}/'+name,Buffer.from(value,'base64'),{flag:'wx',mode:0o600});
fs.writeFileSync('${dir}/job.json',${JSON.stringify(JSON.stringify({ job, sha256: pkg.sha256 }))},{flag:'wx',mode:0o600});`;
        await session.execute("node -", setup);
        await progress({ phase: "uploading", message: messages.uploading });
        preparationStep = "package_upload";
        const bytes = await readFile(pkg.archivePath);
        if (createHash("sha256").update(bytes).digest("hex") !== pkg.sha256) throw Error("ARCHIVE_CHANGED");
        await session.execute(`umask 077; cat > '${dir}/code.tar'`, bytes, 120000);
        await progress({ phase: "starting", message: messages.starting }); launched = true;
        const started = JSON.parse(await session.execute(`node '${dir}/lms-install-job.cjs' --launch '${dir}/job.json'`, JSON.stringify(secrets), 45000));
        if (started.launched !== true || started.id !== current.id) throw Error("INSTALL_LAUNCH_UNCONFIRMED");
        delete (secrets as Partial<typeof secrets>).maintenanceUrl; delete (secrets as Partial<typeof secrets>).clientAdminPassword; delete (secrets as Partial<typeof secrets>).systemAdminPassword;
        for (let i = 0; i < 1800; i++) {
          await this.pause();
          await progress(parseStatus(await session.execute(`cat '${dir}/status.json'`, "", 15000), current));
          if (terminal.has(current.phase)) { if (current.phase === "succeeded") await unlink(secretFile); else { await this.diagnoseRetry(current, session); await this.save(current, report); } return { ...current }; }
        }
        throw Error("INSTALL_OBSERVATION_TIMEOUT");
      });
    } catch (error) {
      if (!state) throw error;
      const code = (error as { code?: string }).code;
      const preparationCode = ({ ssh_connect: "INSTALL_SSH_CONNECT_FAILED", database_check: "INSTALL_DATABASE_CHECK_FAILED", job_setup: "INSTALL_JOB_SETUP_FAILED", package_upload: "INSTALL_PACKAGE_UPLOAD_FAILED" } as Record<string, string>)[preparationStep];
      const errorCode = launched ? "INSTALL_OBSERVATION_INTERRUPTED" : code && Object.hasOwn(databaseErrors, code) ? code : preparationCode || "INSTALL_PREPARATION_FAILED";
      Object.assign(state, { phase: launched ? "disconnected" : "failed", message: launched ? messages.disconnected : databaseErrors[errorCode] || messages.failed,
        errorCode, ...(!launched ? { failedStep: preparationStep } : {}), updatedAt: new Date().toISOString() });
      await this.save(state, report); return state;
    } finally { this.active = false; if (auth) { delete auth.password; delete auth.passphrase; } if (input) { input.maintenanceUrl = ""; input.clientAdminPassword = ""; input.systemAdminPassword = ""; } }
  }
  async refresh(clientId: string, input: unknown, auth: Credentials, report: (value: NewDeploymentState) => void) {
    if (this.active) throw Error("Установка/проверка уже выполняется.");
    this.active = true;
    try {
      const state = await this.get(clientId), target = normalizeRemoteTarget(input);
      if (!state || ["host", "port", "username", "basePath", "fingerprint"].some((key) => target[key as keyof RemoteTarget] !== state.target[key as keyof RemoteTarget])) throw Error("SSH-цель не совпала с заданием.");
      const dir = `/srv/lms-core/jobs/${state.id}`;
      const script = `const fs=require('node:fs');const dir='${dir}';let s=JSON.parse(fs.readFileSync(dir+'/status.json','utf8'));if(!['succeeded','failed','needs_attention'].includes(s.phase)){let alive=false;try{const pid=Number(fs.readFileSync(dir+'/worker.pid','utf8'));const cmd=fs.readFileSync('/proc/'+pid+'/cmdline','utf8');alive=pid>1&&cmd.includes(dir+'/lms-install-job.cjs')&&cmd.includes('--run');}catch{}if(!alive)s={...s,phase:'needs_attention',errorCode:'INSTALL_WORKER_NOT_RUNNING',updatedAt:new Date().toISOString()};}process.stdout.write(JSON.stringify(s));`;
      await this.remote.withSession(state.target, auth, async session => { Object.assign(state, parseStatus(await session.execute("node -", script), state)); await this.diagnoseRetry(state, session); });
      await this.save(state, report); return state;
    } finally { this.active = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
}
