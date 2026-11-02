import { createHash } from "node:crypto";
const fields = ["id", "name", "slug", "domain", "brandName", "tariff", "industryTemplate", "includedUsers", "maxAdmins", "aiRequestsLimit", "primaryColor"];
export type InstallationClientConfiguration = { version: 1; client: Record<string, unknown>; sha256: string };
const fieldLabels: Record<string, string> = { id: "клиент", name: "название", slug: "код клиента", domain: "домен/IP", brandName: "бренд", tariff: "тариф",
  industryTemplate: "отрасль", includedUsers: "лимит пользователей", maxAdmins: "лимит администраторов", aiRequestsLimit: "лимит ИИ", primaryColor: "основной цвет" };

// Only normalized public installation fields participate; passwords and UI metadata never enter this snapshot.
export function installationConfiguration(client: Record<string, unknown>): InstallationClientConfiguration {
  const selected = Object.fromEntries(fields.filter(key => client[key] !== undefined).map(key => [key, client[key]]));
  if (Object.values(selected).some(value => value !== null && !["string", "number"].includes(typeof value))) throw Error("Некорректный снимок конфигурации клиента.");
  return { version: 1, client: selected, sha256: createHash("sha256").update(JSON.stringify(selected)).digest("hex") };
}

export function assertInstallationConfiguration(saved: InstallationClientConfiguration | undefined, current: Record<string, unknown>): void {
  if (!saved || saved.version !== 1 || !/^[a-f0-9]{64}$/.test(saved.sha256) || installationConfiguration(saved.client).sha256 !== saved.sha256) {
    throw Error("Старый план не содержит проверенного полного снимка карточки. Нажмите «Подготовить план»; прежняя проверка сервера не используется.");
  }
  const next = installationConfiguration(current);
  if (next.sha256 !== saved.sha256) {
    const changed = fields.filter(key => saved.client[key] !== next.client[key]).map(key => fieldLabels[key]);
    throw Error(`Карточка клиента изменилась: ${changed.join(", ")}. Подготовьте новый план; неизменный проверенный Git-пакет будет сохранен. Сервер не изменен.`);
  }
}

export function installationDomain(input: unknown): string {
  const message = "Поле «Домен / IP» клиента: укажите домен или IP (например, 188.127.237.167). Допускается http:// или https://, но без порта, пути, логина, пароля и параметров ссылки.";
  if (typeof input !== "string" || /[\x00-\x1f\x7f]/.test(input)) throw Error(message);
  let host = input.trim();
  if (/^https?:\/\//i.test(host)) {
    try {
      const url = new URL(host);
      if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || host.includes("\\")) throw Error();
      host = url.hostname;
    } catch { throw Error(message); }
  }
  if (host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes("..")) throw Error(message);
  return host.toLowerCase();
}

// The UI may hold a URL, while the database deliberately keeps a strict hostname contract.
export function installationClient<T>(raw: Record<string, unknown>, normalize: (value: unknown) => T): T {
  const selected = Object.fromEntries(fields.filter(key => raw[key] !== undefined).map(key => [key, raw[key]]));
  selected.domain = installationDomain(raw.domain);
  try { return normalize(selected); }
  catch (error) {
    if ((error as { code?: string }).code === "INVALID_CLIENT_CONFIG") throw Error("Некорректная карточка клиента: проверьте название, бренд, код клиента, тариф и числовые лимиты. Сервер не изменен. Домен/IP уже проверен отдельно.");
    throw error;
  }
}
