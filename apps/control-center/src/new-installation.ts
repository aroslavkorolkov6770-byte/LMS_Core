import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Credentials, normalizeRemoteTarget, RemoteTarget, RemoteTargetService } from "./remote-target";
import { SourceSnapshotService } from "./source-snapshots";
import { InstallationPackage, InstallationPackageService, InstallationContentMode } from "./installation-package";
import { ClientDesignReference, ClientDesignService } from "./client-design";
import type { PointDesignProvider } from "./point-design";
import { installationDomain, installationClient, installationConfiguration, assertInstallationConfiguration, InstallationClientConfiguration } from "./installation-client";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HOST = /^[a-z0-9][a-z0-9.-]{0,252}$/i;
type Check = { code: string; label: string; status: "passed" | "pending" | "blocked"; message: string };
export type InstallationClient = { id: string; name: string; slug: string; domain: string };
export type InstallationDatabase = { engine: "postgresql"; host: string; port: number; name: string; user: string; credentialConfigured: boolean };
export type NewServerPreflight = {
  checkedAt: string; os: string; username: string; uid: number; appPath: string;
  pathState: "available" | "occupied" | "unsafe"; writable: boolean;
  node: string; npm: string; pm2: string; systemd?: boolean; apiPort?: number | null; ssAvailable: boolean; candidatePort: number | null;
  freeDiskBytes: number; memoryBytes: number; swapBytes: number;
  postgresState?: "ready" | "missing" | "unavailable" | "unknown";
};
export type NewInstallationPlan = {
  version: 1; kind: "new_installation"; id: string; createdAt: string;
  client: InstallationClient; target: RemoteTarget; database: InstallationDatabase;
  paths: { root: string; releases: string; shared: string; current: string };
  processName: string; admins: { clientLogin: string; systemLogin: string };
  source: { snapshotId: string; repositoryUrl: string; requestedBranch: string; branch: string; revision: string; archiveSha256: string;
    databaseBackends: string[]; bootstrapAdminFromEnvironment: boolean };
  package?: InstallationPackage; preflight: NewServerPreflight | null; checks: Check[]; status: "blocked" | "needs_server_check" | "prepared";
  design?: ClientDesignReference; designRequired?: boolean;
  presentationMode?: "source" | "custom" | "point"; presentationReviewRequired?: boolean;
  clientConfiguration?: InstallationClientConfiguration;
  contentMode?: InstallationContentMode;
};

function publicText(value: unknown, maximum = 255): string {
  return typeof value === "string" && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : "";
}

export function normalizeInstallationProfile(input: unknown, expectedClientId: string): {
  client: InstallationClient; database: InstallationDatabase; admins: NewInstallationPlan["admins"];
} {
  const value = input as { client?: Record<string, unknown>; profile?: Record<string, unknown>; adminCredentials?: Record<string, unknown> } | null;
  const raw = value?.client;
  if (!UUID.test(expectedClientId) || !raw || raw.id !== expectedClientId) throw new Error("API вернул другого клиента или неполную карточку.");
  const slug = publicText(raw.slug, 40);
  const name = publicText(raw.name);
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("У клиента должен быть корректный код: строчные латинские буквы, цифры и дефис, до 40 символов.");
  const profile = value?.profile || {};
  const dbHost = publicText(profile.databaseHost);
  const dbName = publicText(profile.databaseName, 63);
  const dbUser = publicText(profile.databaseUser, 63);
  if (dbHost && (!HOST.test(dbHost) || dbHost.includes(".."))) throw new Error("В профиле БД нужен только IP или hostname, без пароля и URL.");
  if ([dbName, dbUser].some((part) => part && !/^[a-z_][a-z0-9_]*$/i.test(part))) throw new Error("В имени БД и пользователя допускаются латинские буквы, цифры и подчёркивание.");
  const port = Number(profile.databasePort ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Некорректный порт PostgreSQL в карточке клиента.");
  return {
    client: { id: expectedClientId, slug, name, domain: installationDomain(raw.domain) },
    database: { engine: "postgresql", host: dbHost, port, name: dbName, user: dbUser,
      credentialConfigured: Boolean(publicText(profile.databasePasswordSecretRef)) },
    admins: { clientLogin: publicText(value?.adminCredentials?.clientAdminLogin), systemLogin: publicText(value?.adminCredentials?.systemAdminLogin) }
  };
}

export function newInstallationPaths(basePath: string, slug: string): NewInstallationPlan["paths"] {
  const target = normalizeRemoteTarget({ host: "validation.invalid", port: 22, username: "root", basePath, fingerprint: "" });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 40) throw new Error("Некорректный код клиента для автоматического пути.");
  const root = path.posix.join(target.basePath, slug);
  return { root, releases: `${root}/releases`, shared: `${root}/shared`, current: `${root}/current` };
}

export function inspectInstallationSource(configText: string, authText: string): Pick<NewInstallationPlan["source"], "databaseBackends" | "bootstrapAdminFromEnvironment"> {
  // Static metadata only: no imports, evaluation or printing auth/credential literals.
  const union = /(?:export\s+)?type\s+DataBackend\s*=([^;]{1,400});/.exec(configText)?.[1] || "";
  const databaseBackends = [...union.matchAll(/['"](json|mysql|postgres|postgresql)['"]/g)].map((match) => match[1]);
  return { databaseBackends: [...new Set(databaseBackends)],
    bootstrapAdminFromEnvironment: authText.includes("process.env.BOOTSTRAP_ADMIN_LOGIN") && authText.includes("process.env.BOOTSTRAP_ADMIN_PASSWORD") };
}

export function installationChecks(plan: Omit<NewInstallationPlan, "checks" | "status">): Check[] {
  const databaseReady = Boolean(plan.database.host && plan.database.name && plan.database.user && plan.database.credentialConfigured);
  const mode = plan.presentationMode ?? (plan.design || plan.designRequired ? "custom" : "source");
  const presentationReady = !plan.presentationReviewRequired && (mode === "source" ? !plan.design && !plan.designRequired && !plan.package?.design : !!plan.design && plan.designRequired === true && (mode === "point" ? plan.design.version === 3 : plan.design.version !== 3));
  const checks: Check[] = [
    { code: "CONTENT_POLICY", label: "Наполнение учебной базы", status: plan.contentMode && (!plan.package || (plan.package.contentMode ?? "empty") === plan.contentMode) ? "passed" : "blocked",
      message: !plan.contentMode ? "Выберите материалы Git или пустую базу и подготовьте новый план." : plan.contentMode === "empty" ? "Темы и тесты не переносятся. Установщик подтвердит пустые учебные коллекции." : plan.package?.curriculum ? `Из выбранного Git: тем ${plan.package.curriculum.topics}, тестов ${plan.package.curriculum.tests}, вопросов ${plan.package.curriculum.questions}. Пользователи и прогресс не копируются.` : "Темы и тесты будут извлечены из точного Git commit при сборке пакета. Пользователи, прогресс и неиспользуемые разделы не переносятся." },
    { code: "CLIENT_CONFIGURATION", label: "Снимок конфигурации клиента", status: plan.clientConfiguration ? "passed" : "blocked", message: plan.clientConfiguration ? "Публичные поля карточки зафиксированы; перед сборкой и запуском изменения проверяются заново. Пароли в снимок не входят." : "Старый план без полного снимка карточки. Подготовьте новый план; архив кода можно переиспользовать после проверки." },
    { code: "CLIENT", label: "Клиент и автоматический путь", status: plan.target.basePath === "/srv/lms-core/clients" ? "passed" : "blocked", message: `${plan.client.name}: ${plan.paths.root}. Новый installer использует стандарт /srv/lms-core/clients.` },
    { code: "SOURCE", label: "Зафиксированная Git-версия", status: "passed", message: `${plan.source.branch} / ${plan.source.revision.slice(0, 12)}` },
    { code: "PRESENTATION", label: mode === "source" ? "Исходный вид Git-LMS" : mode === "point" ? "Сохраненные точечные правки Git-LMS" : "Явно выбранное оформление", status: presentationReady ? "passed" : "blocked",
      message: !presentationReady ? "План содержит старое или несовместимое оформление. Пересоздайте план с текущими сохраненными правками; старые defaults не применяются автоматически." : mode === "source" ? "Оригинальные логотип, темы, тексты и кнопки. Старые настройки редактора не применяются автоматически." : mode === "point" ? "Исходный Git-интерфейс и только явно сохраненные правки выбранных элементов. Логотип и остальные стили не заменяются." : "Оформление выбрано отдельно; оно не является исходным Git-видом." },
    { code: "DATABASE_PROFILE", label: "Отдельная PostgreSQL клиента", status: databaseReady ? "passed" : "pending",
      message: databaseReady ? `${plan.database.host}:${plan.database.port} / ${plan.database.name}; это параметры, не проверка соединения.` : "В карточке клиента нужны хост, порт, имя БД, пользователь и ссылка на защищённый пароль." },
    { code: "ADMIN_PROFILE", label: "Администраторы клиента", status: plan.admins.clientLogin && plan.admins.systemLogin ? "passed" : "pending",
      message: plan.admins.clientLogin && plan.admins.systemLogin ? "Логины сохранены в Core. Это ещё не создание аккаунтов в новой LMS." : "Заполните логины администратора клиента и системного администратора в карточке." },
    { code: "POSTGRES_ADAPTER", label: "Управляемая LMS: Git + backend Core", status: plan.package ? "passed" : "blocked",
      message: plan.package ? `Проверенный пакет ${plan.package.id.slice(0, 8)}; ${plan.contentMode === "source" ? "учебные материалы Git" : "пустая база"}; commit ${plan.package.revision.slice(0, 12)}. Это Git-код с явными адаптерами Core, не неизмененная копия репозитория.` : `Пакет для Git ${plan.source.revision.slice(0, 12)} еще не собран и не проверен. Нажмите «Собрать пакет». Если эта версия еще не подготовлена адаптером Core, будет показана точная причина; SSH-пароль здесь ни при чем.` },
    { code: "SYSTEM_ADMIN_BOOTSTRAP", label: "Создание системного администратора без встроенного пароля", status: "pending",
      message: plan.source.bootstrapAdminFromEnvironment ? "В исходниках есть настройка первого admin через окружение; отдельный контракт системного администратора ещё нужно связать с Core." : "Для выбранного Git-источника ещё не подтверждён контракт настройки администраторов. Пароли пилота не переносятся." }
  ];
  if (plan.designRequired || plan.design) checks.push({ code: "DESIGN", label: "Сохраненные тексты, цвета и шрифты", status: plan.design && (!plan.package || plan.package.design?.sha256 === plan.design.sha256 && plan.package.design.clientId === plan.client.id) ? "passed" : "blocked", message: plan.design ? `Снимок ${plan.design.sha256.slice(0, 12)}; только сохраненные настройки. Пакет не содержит черновиков редактора.` : "Подготовьте новый план с сохраненным оформлением; старый пакет нельзя использовать для этой установки." });
  if (plan.package?.design?.warnings?.length) checks.push({ code: "DESIGN_COMPATIBILITY", label: "Измененные настройки без соответствия в Git-шаблоне", status: "pending", message: `Не будут применены: ${plan.package.design.warnings.slice(0, 12).map((item) => item.setting).join(", ")}${plan.package.design.warnings.length > 12 ? " и другие (полный список в manifest пакета)" : ""}. Отсутствующие блоки не создаются; скрытие и перемещение формы входа защищены.` });
  if (!plan.target.fingerprint) checks.push({ code: "SSH_PIN", label: "Идентичность SSH-сервера", status: "pending", message: "Перед проверкой сервера нужен независимо подтверждённый отпечаток." });
  const server = plan.preflight;
  if (!server) {
    checks.push({ code: "SERVER", label: "Проверка сервера", status: "pending", message: "Проверка по SSH ещё не выполнена. Каталоги на сервере не создавались." });
  } else {
    checks.push({ code: "NEW_PATH", label: "Путь новой установки", status: server.pathState === "available" && server.writable ? "passed" : "blocked",
      message: server.pathState === "occupied" ? "Этот каталог уже существует. Новая установка не будет его перезаписывать." : server.pathState === "unsafe" ? "В пути обнаружена ссылка или небезопасный компонент." : server.writable ? "Каталог свободен, родитель доступен для создания. Пока ничего не создано." : "Нет прав на создание каталога." });
    const runtimeReady = /^v(?:2[2-9]|[3-9]\d)\./.test(server.node) && Boolean(server.npm) && server.systemd === true && server.uid === 0;
    checks.push({ code: "RUNTIME", label: "Серверное окружение", status: runtimeReady ? "passed" : "blocked",
      message: runtimeReady ? `Node ${server.node}; npm ${server.npm}; systemd и root подтверждены.` : `Node: ${server.node || "не установлен"}; npm: ${server.npm || "не установлен"}; systemd: ${server.systemd ? "работает" : "не подтвержден"}; root: ${server.uid === 0 ? "да" : "нет"}. На чистой Ubuntu нажмите «Подготовить чистую Ubuntu», затем повторите проверку. PM2 не нужен.` });
    checks.push({ code: "LOCAL_POSTGRES", label: "Автоматическая PostgreSQL на этом сервере", status: server.postgresState === "ready" ? "passed" : "pending",
      message: server.postgresState === "ready" ? "Служебный доступ подтвержден запросом без изменения данных." : server.postgresState === "missing" ? "PostgreSQL не установлена. Нажмите «Подготовить чистую Ubuntu», затем «Проверить сервер». Старая LMS не изменяется." : server.postgresState === "unavailable" ? "PostgreSQL найдена, но служебное подключение недоступно. Нужна проверка службы/доступа; пароли и настройки существующей БД автоматически не меняются." : "Повторите «Проверить сервер», чтобы подтвердить PostgreSQL. При отдельном сервере БД используйте административные реквизиты на шаге установки." });
    // A nominal 1 GB VPS exposes slightly less MemTotal after kernel reservations.
    checks.push({ code: "MEMORY", label: "Память для сборки", status: server.memoryBytes >= 900 * 1024 ** 2 && server.memoryBytes + server.swapBytes >= 3 * 1024 ** 3 ? "passed" : "blocked",
      message: `Доступная системе RAM: ${Math.round(server.memoryBytes / 1024 ** 2)} МиБ; swap: ${(server.swapBytes / 1024 ** 3).toFixed(2)} ГиБ; всего: ${((server.memoryBytes + server.swapBytes) / 1024 ** 3).toFixed(2)} ГиБ. Нужны MemTotal от 900 МиБ и RAM + swap от 3 ГиБ. При нехватке нажмите «Добавить swap до 4 ГиБ» или увеличьте RAM у хостера; затем повторите проверку.` });
    checks.push({ code: "PORT", label: "Отдельный процесс и порт", status: server.candidatePort && server.apiPort ? "passed" : "blocked",
      message: server.candidatePort ? `${plan.processName}; кандидат ${server.candidatePort}. Порт не зарезервирован: перед запуском нужна повторная проверка.` : "Свободный порт не подтверждён; существующие процессы не останавливаются." });
    checks.push({ code: "DISK", label: "Диск для сборки", status: server.freeDiskBytes >= 7 * 1024 ** 3 ? "passed" : "blocked",
      message: `Свободно ${(server.freeDiskBytes / 1024 ** 3).toFixed(1)} GiB. Для безопасной подготовки требуется от 7 GiB.` });
  }
  return checks;
}

export function parseNewServerPreflight(text: string, expectedPath: string): NewServerPreflight {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const tab = line.indexOf("\t");
    if (tab <= 0 || map.has(line.slice(0, tab)) || /[\x00-\x08\x0b-\x1f\x7f]/.test(line.slice(tab + 1))) throw new Error("Некорректный ответ проверки новой установки.");
    map.set(line.slice(0, tab), line.slice(tab + 1));
  }
  const number = (key: string) => {
    const raw = map.get(key);
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("Сервер вернул неполные параметры ресурсов.");
    return Number(raw);
  };
  const field = (key: string, maximum = 255) => {
    const value = map.get(key);
    if (value === undefined || value.length > maximum) throw new Error("Неполный результат SSH-проверки.");
    return value;
  };
  if (field("protocol") !== "lms-new-install-v1" || field("kernel") !== "Linux" || field("appPath", 1024) !== expectedPath) throw new Error("Проверка относится к другой платформе или пути.");
  const pathState = field("pathState");
  if (!["available", "occupied", "unsafe"].includes(pathState) || !["0", "1"].includes(field("writable")) || !["0", "1"].includes(field("ssAvailable"))) throw new Error("Некорректные признаки проверки сервера.");
  const candidate = number("candidatePort");
  if (candidate && (candidate < 3000 || candidate > 3099 || field("ssAvailable") !== "1") ||
    map.has("apiPort") && number("apiPort") !== 0 && (number("apiPort") < 4101 || number("apiPort") > 4199 || field("ssAvailable") !== "1") ||
    map.has("systemd") && !["0", "1"].includes(field("systemd"))) throw new Error("Некорректный кандидат HTTP-порта или systemd.");
  const postgresState = map.get("postgresState") ?? "unknown";
  if (!["ready", "missing", "unavailable", "unknown"].includes(postgresState)) throw Error("Некорректный результат проверки PostgreSQL.");
  return { checkedAt: new Date().toISOString(), os: field("os"), username: field("username", 64), uid: number("uid"), appPath: expectedPath,
    pathState: pathState as NewServerPreflight["pathState"], writable: field("writable") === "1", node: field("node", 100), npm: field("npm", 100), pm2: field("pm2", 1024),
    systemd: map.get("systemd") === "1", apiPort: map.has("apiPort") ? number("apiPort") || null : null, postgresState: postgresState as NewServerPreflight["postgresState"],
    ssAvailable: field("ssAvailable") === "1", candidatePort: candidate || null, freeDiskBytes: number("freeDiskBytes"), memoryBytes: number("memoryBytes"), swapBytes: number("swapBytes") };
}

export class NewInstallationService {
  private busy = false;
  private readonly directory: string;
  constructor(private readonly root: string, private readonly sources: Pick<SourceSnapshotService, "verifySnapshot">,
    private readonly remote: RemoteTargetService, private readonly loadClient: (id: string) => Promise<unknown>, private readonly packages?: Pick<InstallationPackageService, "prepare" | "verify">,
    private readonly designs?: Pick<ClientDesignService, "capture" | "currentHash" | "read">,
    private readonly points?: PointDesignProvider) {
    this.directory = path.join(root, "infra/runtime/new-installations");
  }
  private normalizedClient(detail: unknown): Record<string, unknown> {
    const raw = (detail as { client?: Record<string, unknown> })?.client;
    if (!raw) throw Error("Карточка клиента недоступна; сервер не изменен.");
    const db = require(path.join(__dirname, "../../../packages/db/dist/src/index.js")) as { normalizeFreshClient(value: unknown): Record<string, unknown> };
    return installationClient(raw, db.normalizeFreshClient);
  }
  assertProfileCurrent(plan: NewInstallationPlan, detail: unknown): void {
    assertInstallationConfiguration(plan.clientConfiguration, this.normalizedClient(detail));
    const profile = normalizeInstallationProfile(detail, plan.client.id);
    if (JSON.stringify(profile.database) !== JSON.stringify(plan.database)) throw Error("Карточка клиента изменилась: параметры БД. Подготовьте новый план; Git-пакет не требует пересборки, если источник и оформление прежние.");
    if (JSON.stringify(profile.admins) !== JSON.stringify(plan.admins)) throw Error("Карточка клиента изменилась: логины администраторов. Подготовьте новый план; старые доступы не подставляются.");
  }
  private async save(plan: NewInstallationPlan): Promise<NewInstallationPlan> {
    plan.checks = installationChecks(plan);
    plan.status = plan.checks.some((check) => check.status === "blocked") ? "blocked" : "needs_server_check";
    if (!plan.checks.some((check) => check.status === "blocked") && plan.package && plan.preflight && plan.checks.filter((check) => ["CLIENT", "PRESENTATION", "POSTGRES_ADAPTER", "DESIGN", "NEW_PATH", "RUNTIME", "MEMORY", "PORT", "DISK"].includes(check.code)).every((check) => check.status === "passed")) plan.status = "prepared";
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `${plan.client.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    // Only the explicit public plan is persisted. API objects and SSH credentials are not copied.
    await writeFile(temporary, JSON.stringify(plan, null, 2), { flag: "wx" });
    await rename(temporary, file);
    return plan;
  }
  async get(clientId: string): Promise<NewInstallationPlan | null> {
    if (!UUID.test(clientId)) return null;
    try {
      const raw = JSON.parse(await readFile(path.join(this.directory, `${clientId}.json`), "utf8")) as NewInstallationPlan;
      if (raw.version !== 1 || raw.kind !== "new_installation" || !UUID.test(raw.id) || raw.client?.id !== clientId || !UUID.test(raw.source?.snapshotId) ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(raw.source.revision) || !/^[a-f0-9]{64}$/.test(raw.source.archiveSha256) || !Number.isFinite(Date.parse(raw.createdAt))) return null;
      const target = normalizeRemoteTarget(raw.target);
      const profile = normalizeInstallationProfile({ client: raw.client, profile: { databaseHost: raw.database.host, databasePort: raw.database.port,
        databaseName: raw.database.name, databaseUser: raw.database.user, databasePasswordSecretRef: raw.database.credentialConfigured ? "configured" : "" },
        adminCredentials: { clientAdminLogin: raw.admins.clientLogin, systemAdminLogin: raw.admins.systemLogin } }, clientId);
      const paths = newInstallationPaths(target.basePath, profile.client.slug);
      if (target.appPath !== paths.root || raw.database.engine !== "postgresql") return null;
      const source: NewInstallationPlan["source"] = { snapshotId: raw.source.snapshotId, revision: raw.source.revision, archiveSha256: raw.source.archiveSha256,
        repositoryUrl: publicText(raw.source.repositoryUrl, 1024), requestedBranch: publicText(raw.source.requestedBranch), branch: publicText(raw.source.branch),
        databaseBackends: Array.isArray(raw.source.databaseBackends) ? raw.source.databaseBackends.filter((item) => ["json", "mysql", "postgres", "postgresql"].includes(item)) : [],
        bootstrapAdminFromEnvironment: raw.source.bootstrapAdminFromEnvironment === true };
      const preflight = raw.preflight ? this.storedPreflight(raw.preflight, paths.root) : null;
      const plan: NewInstallationPlan = { version: 1, kind: "new_installation", id: raw.id, createdAt: raw.createdAt, ...profile,
        target, paths, processName: `lms-${profile.client.slug}`, source, preflight, checks: [], status: "blocked" };
      if (raw.contentMode !== undefined && !["empty", "source"].includes(raw.contentMode)) return null;
      plan.contentMode = raw.contentMode;
      if (raw.clientConfiguration) {
        const normalized = this.normalizedClient({ client: raw.clientConfiguration.client });
        assertInstallationConfiguration(raw.clientConfiguration, normalized);
        if (["id", "name", "slug", "domain"].some(key => normalized[key] !== profile.client[key as keyof InstallationClient])) return null;
        plan.clientConfiguration = installationConfiguration(normalized);
      }
      if (raw.presentationMode !== undefined && !["source", "custom", "point"].includes(raw.presentationMode)) return null;
      plan.presentationMode = raw.presentationMode ?? (raw.design || raw.designRequired ? "custom" : "source");
      plan.presentationReviewRequired = raw.presentationMode === undefined && Boolean(raw.design || raw.designRequired || raw.package?.design);
      plan.designRequired = plan.presentationMode === "custom" || plan.presentationMode === "point";
      if (raw.design) {
        if (!this.designs) return null;
        await this.designs.read(raw.design); plan.design = raw.design;
      }
      if (raw.package && this.packages) {
        try { const verified = await this.packages.verify(raw.package, source.snapshotId); const { archivePath: ignored, ...publicValue } = verified; plan.package = publicValue; } catch { /* A stale archive cannot unlock installation. */ }
      }
      if (this.points && !await this.designCurrent(plan)) plan.presentationReviewRequired = true;
      plan.checks = installationChecks(plan);
      plan.status = plan.checks.some((check) => check.status === "blocked") ? "blocked" : "needs_server_check";
      if (!plan.checks.some((check) => check.status === "blocked") && plan.package && plan.preflight && plan.checks.filter((check) => ["CLIENT", "PRESENTATION", "POSTGRES_ADAPTER", "DESIGN", "NEW_PATH", "RUNTIME", "MEMORY", "PORT", "DISK"].includes(check.code)).every((check) => check.status === "passed")) plan.status = "prepared";
      return plan;
    } catch { return null; }
  }
  private storedPreflight(value: NewServerPreflight, expectedPath: string): NewServerPreflight {
    const pairs: Record<string, string | number> = { protocol: "lms-new-install-v1", kernel: "Linux", os: value.os, username: value.username,
      uid: value.uid, appPath: value.appPath, pathState: value.pathState, writable: value.writable ? 1 : 0, node: value.node, npm: value.npm, pm2: value.pm2,
      systemd: value.systemd ? 1 : 0, apiPort: value.apiPort ?? 0, postgresState: value.postgresState ?? "unknown", ssAvailable: value.ssAvailable ? 1 : 0, candidatePort: value.candidatePort ?? 0, freeDiskBytes: value.freeDiskBytes, memoryBytes: value.memoryBytes, swapBytes: value.swapBytes };
    const result = parseNewServerPreflight(Object.entries(pairs).map(([key, item]) => `${key}\t${item}`).join("\n"), expectedPath);
    if (!Number.isFinite(Date.parse(value.checkedAt))) throw new Error("Некорректное время проверки.");
    return { ...result, checkedAt: value.checkedAt };
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Подготовка новой установки уже выполняется.");
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  async prepare(clientId: string, snapshotId: string, input: unknown, presentationMode: "source" | "custom" = "source", contentMode: InstallationContentMode = "empty"): Promise<NewInstallationPlan> {
    return this.exclusive(async () => {
      if (!UUID.test(clientId)) throw new Error("Выберите клиента из Core.");
      if (!["source", "custom"].includes(presentationMode) || presentationMode === "custom" && !this.designs) throw Error("Режим оформления недоступен.");
      if (!["empty", "source"].includes(contentMode)) throw Error("Выберите наполнение LMS: материалы Git или пустая база.");
      const detail = await this.loadClient(clientId);
      const profile = normalizeInstallationProfile(detail, clientId);
      const configuration = installationConfiguration(this.normalizedClient(detail));
      const previous = await this.get(clientId);
      const snapshot = await this.sources.verifySnapshot(snapshotId);
      const normalized = normalizeRemoteTarget(input);
      const paths = newInstallationPaths(normalized.basePath, profile.client.slug);
      // The existing application's update path is intentionally ignored for a NEW installation.
      const target = { ...normalized, appPath: paths.root };
      const readMetadata = async (relative: string) => {
        try {
          const file = path.join(snapshot.sourcePath, relative);
          if ((await stat(file)).size > 512 * 1024) return "";
          return await readFile(file, "utf8");
        } catch { return ""; }
      };
      const capabilities = inspectInstallationSource(await readMetadata("app/lib/database/config.ts"), await readMetadata("app/lib/serverAuth.ts"));
      const plan: NewInstallationPlan = { version: 1, kind: "new_installation", id: randomUUID(), createdAt: new Date().toISOString(), ...profile,
        target, paths, processName: `lms-${profile.client.slug}`, source: { snapshotId: snapshot.id, repositoryUrl: snapshot.repositoryUrl,
          requestedBranch: snapshot.requestedBranch, branch: snapshot.branch, revision: snapshot.revision, archiveSha256: snapshot.archiveSha256, ...capabilities },
        preflight: null, checks: [], status: "blocked", presentationMode, designRequired: presentationMode === "custom", clientConfiguration: configuration, contentMode };
      if (presentationMode === "custom") plan.design = await this.designs!.capture(clientId);
      else if (this.points) {
        const point = await this.points.captureOptional(clientId, snapshot.revision);
        if (point) { plan.design = point; plan.designRequired = true; plan.presentationMode = "point"; }
      }
      // Client metadata and SSH changes do not alter the code archive. Never reuse a server check here.
      if (previous?.package && this.packages && (previous.package.contentMode ?? "empty") === contentMode && previous.source.snapshotId === plan.source.snapshotId && previous.source.revision === plan.source.revision &&
          previous.source.archiveSha256 === plan.source.archiveSha256 && previous.presentationMode === plan.presentationMode &&
          (previous.design?.sha256 || "") === (plan.design?.sha256 || "") && (previous.design?.clientId || "") === (plan.design?.clientId || "")) {
        try { const verified = await this.packages.verify(previous.package, plan.source.snapshotId); const { archivePath: ignored, ...value } = verified; plan.package = value; }
        catch { /* Rebuild only the rejected code archive; the historical plan is left untouched. */ }
      }
      return this.save(plan);
    });
  }
  async checkServer(clientId: string, planId: string, input: unknown, auth: Credentials): Promise<NewInstallationPlan> {
    try {
      return await this.exclusive(async () => {
        const plan = await this.get(clientId);
        if (!plan || plan.id !== planId) throw new Error("План устарел. Подготовьте новую установку заново.");
        if (plan.checks.find((check) => check.code === "PRESENTATION")?.status !== "passed") throw Error("Пересоздайте план с исходным видом Git перед проверкой сервера.");
        if (!await this.designCurrent(plan)) throw Error("Сохраненное оформление изменилось. Подготовьте новый план перед проверкой сервера.");
        this.assertProfileCurrent(plan, await this.loadClient(clientId));
        const target = normalizeRemoteTarget(input);
        if (["host", "port", "username", "basePath", "fingerprint"].some((key) => target[key as keyof RemoteTarget] !== plan.target[key as keyof RemoteTarget])) throw new Error("SSH-параметры изменены. Сначала пересоздайте план для новой цели.");
        const snapshot = await this.sources.verifySnapshot(plan.source.snapshotId);
        if (snapshot.revision !== plan.source.revision || snapshot.archiveSha256 !== plan.source.archiveSha256) throw new Error("Git-версия плана изменилась. Нужна новая подготовка.");
        const template = await readFile(path.join(this.root, "infra/scripts/lms-new-install-preflight.sh"), "utf8");
        const script = template.replaceAll("__CORE_INSTALL_PATH__", plan.paths.root)
          .replaceAll("__CORE_WEB_PORT_START__", ["127.0.0.1", "localhost"].includes(plan.target.host) ? "3010" : "3000");
        const output = await this.remote.withSession(plan.target, auth, (session) => session.execute("sh -s", script));
        plan.preflight = parseNewServerPreflight(output, plan.paths.root);
        return this.save(plan);
      });
    } finally { if (auth) { delete auth.password; delete auth.passphrase; } }
  }
  async preparePackage(clientId: string, planId: string): Promise<NewInstallationPlan> {
    return this.exclusive(async () => {
      const plan = await this.get(clientId);
      if (!plan || plan.id !== planId || !this.packages) throw new Error("План устарел или упаковщик недоступен.");
      this.assertProfileCurrent(plan, await this.loadClient(clientId));
      if (!plan.contentMode) throw Error("Выберите наполнение LMS и подготовьте новый план.");
      if (plan.checks.find((check) => check.code === "PRESENTATION")?.status !== "passed") throw Error("Пересоздайте план с исходным видом Git перед сборкой пакета.");
      if (!await this.designCurrent(plan)) throw Error("Сохраненное оформление изменилось. Подготовьте новый план перед сборкой пакета.");
      const pkg = await this.packages.prepare(plan.source.snapshotId, plan.design, plan.contentMode);
      if ((pkg.contentMode ?? "empty") !== plan.contentMode) throw Error("Наполнение пакета не совпадает с выбранным режимом. Подготовьте пакет заново.");
      if (plan.presentationMode === "source" && pkg.design) throw Error("Пакет содержит оформление вместо исходного Git-вида. Пересоздайте план и пакет.");
      plan.package = pkg;
      return this.save(plan);
    });
  }
  private async designCurrent(plan: NewInstallationPlan): Promise<boolean> {
    if (plan.presentationMode === "point") return !!plan.design && !!this.points && await this.points.currentHash(plan.client.id, plan.source.revision) === plan.design.sha256;
    if (plan.designRequired) return !!plan.design && !!this.designs && await this.designs.currentHash(plan.client.id) === plan.design.sha256;
    // A source-only plan also becomes stale if a point document was saved afterwards.
    return !this.points || !await this.points.hasChanges(plan.client.id, plan.source.revision);
  }
}
