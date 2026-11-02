import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex, Readable } from "node:stream";

export type RemoteTarget = { host: string; port: number; username: string; basePath: string; fingerprint: string; appPath?: string };
export type RemoteInventory = { checkedAt: string; os: string; kernel: string; user: string; node: string; npm: string;
  postgres: string; mysql: string; mariadb: string; projectPaths: string[] };
type Channel = Duplex & { stderr: Readable };
// A narrow transport contract keeps the connection independently testable.
export interface SshTransport extends EventEmitter {
  connect(options: { host: string; port: number; username: string; readyTimeout: number; keepaliveInterval?: number; keepaliveCountMax?: number;
    hostVerifier: (key: Buffer) => boolean; password?: string; privateKey?: Buffer; passphrase?: string }): void;
  exec(command: string, callback: (error: Error | undefined, channel: Channel) => void): void;
  forwardOut?(sourceHost: string, sourcePort: number, host: string, port: number, callback: (error: Error | undefined, channel: Duplex) => void): void;
  end(): void;
  destroy(): void;
}
export type Credentials = { mode: "password" | "key"; password?: string; identityFile?: string; passphrase?: string; savedForClient?: string };
export type RemoteSession = { execute(command: string, input?: string | Buffer, timeout?: number): Promise<string>;
  openLoopback?(port: number): Promise<Duplex>; onClose?(callback: () => void): () => void };
export class RemoteConnectionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function connectionFailure(error: unknown, changed = false): RemoteConnectionError {
  const value = error as { level?: string; code?: string } | undefined;
  if (changed) return new RemoteConnectionError("SSH_HOST_CHANGED", "Отпечаток SSH-сервера не совпал. Авторизация заблокирована; перепроверьте сервер.");
  if (value?.level === "client-authentication") return new RemoteConnectionError("SSH_AUTH_REJECTED", "Сервер отклонил SSH-вход: пароль или ключ не принят. Проверьте пользователя, способ входа и пароль сервера; не пароль GitHub или LMS. Повторите только после проверки данных.");
  if (value?.level === "client-timeout" || ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(value?.code || "")) return new RemoteConnectionError("SSH_TIMEOUT", "SSH-вход не завершился за 30 секунд. Возможны задержка сети или нагрузка сервера; неверный пароль этим не подтверждён.");
  if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(value?.code || "")) return new RemoteConnectionError("SSH_UNREACHABLE", "SSH-сервер недоступен. Проверьте адрес, порт и сеть; пароль не является подтверждённой причиной.");
  if (["ECONNRESET", "EPIPE"].includes(value?.code || "") || value?.level === "client-socket") return new RemoteConnectionError("SSH_CONNECTION_CLOSED", "SSH-соединение оборвалось до входа. Возможны сеть, лимит подключений или ограничение на сервере. Не повторяйте пароль многократно подряд.");
  return new RemoteConnectionError("SSH_CONNECTION_FAILED", "SSH-вход не выполнен. Причина не определена: проверьте пользователя, пароль/ключ и сеть. Серверный код не запускался.");
}
export type UpdatePreflight = {
  checkedAt: string; appRoot: string; backend: "json" | "mysql" | "unknown"; environmentFiles: string[];
  protectedPaths: Array<{ path: string; kind: string; bytes: number; files: number; truncated: boolean }>;
  packageManager: string; projectKind: string; hasBuild: boolean; hasStart: boolean;
  managers: { pm2: Array<{ id: number; name: string; status: string; cwd: string; port: number | null }>;
    systemd: Array<{ name: string; cwd: string }> };
  diskFreeBytes: number; memoryTotalBytes: number; memoryFreeBytes: number; warnings: string[];
};
const emptyTarget: RemoteTarget = { host: "", port: 22, username: "", basePath: "/srv/lms-core/clients", fingerprint: "" };

function isUpdatePreflight(input: unknown): input is UpdatePreflight {
  if (!input || typeof input !== "object") return false;
  const value = input as UpdatePreflight;
  return typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)) && typeof value.appRoot === "string" &&
    ["json", "mysql", "unknown"].includes(value.backend) && typeof value.packageManager === "string" && typeof value.projectKind === "string" &&
    Array.isArray(value.environmentFiles) && value.environmentFiles.every((item) => typeof item === "string") &&
    Array.isArray(value.warnings) && value.warnings.every((item) => typeof item === "string") &&
    Array.isArray(value.protectedPaths) && value.protectedPaths.every((item) => item && typeof item.path === "string" &&
      typeof item.kind === "string" && Number.isFinite(item.bytes) && item.bytes >= 0 && Number.isFinite(item.files) && item.files >= 0) &&
    Array.isArray(value.managers?.pm2) && value.managers.pm2.every((item) => typeof item.name === "string" && typeof item.status === "string") &&
    Array.isArray(value.managers?.systemd) && value.managers.systemd.every((item) => typeof item.name === "string") &&
    [value.diskFreeBytes, value.memoryTotalBytes, value.memoryFreeBytes].every((item) => Number.isFinite(item) && item >= 0);
}

export function normalizeRemoteTarget(input: unknown): RemoteTarget {
  if (!input || typeof input !== "object") throw new Error("Введите SSH-параметры сервера.");
  const raw = input as Record<string, unknown>;
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  const port = Number(raw.port);
  const basePath = typeof raw.basePath === "string" ? raw.basePath.trim() : "";
  const fingerprint = typeof raw.fingerprint === "string" ? raw.fingerprint.trim() : "";
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host) || host.includes("..")) throw new Error("Нужен IP или имя сервера без https://, пути и пароля.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH-порт должен быть числом от 1 до 65535.");
  if (!/^[a-z_][a-z0-9_-]{0,63}$/i.test(username)) throw new Error("Некорректное имя SSH-пользователя.");
  if (!/^\/(?:[a-z0-9_-][a-z0-9_.-]*\/)+[a-z0-9_-][a-z0-9_.-]*$/i.test(basePath) || basePath.includes("..")) {
    throw new Error("Укажите отдельный абсолютный каталог, например /srv/lms-core/clients, а не корень сервера.");
  }
  if (fingerprint && !/^SHA256:[a-zA-Z0-9+/]{43}$/.test(fingerprint)) throw new Error("Отпечаток должен иметь вид SHA256:… из 43 символов после двоеточия.");
  const appPath = typeof raw.appPath === "string" ? raw.appPath.trim() : "";
  if (appPath && (!/^\/(?:[a-z0-9_-][a-z0-9_.-]*\/)+[a-z0-9_-][a-z0-9_.-]*$/i.test(appPath) ||
      appPath.includes("..") || appPath.split("/").some((part) => [".next", ".git", "node_modules"].includes(part)))) {
    throw new Error("Укажите корень установленной LMS, не .next, node_modules или системный корень.");
  }
  return { host, port, username, basePath, fingerprint, ...(appPath ? { appPath } : {}) };
}

function fingerprintOf(key: Buffer): string { return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`; }

const INVENTORY_SCRIPT = `set -u
printf 'user\t'; id -un
printf 'kernel\t'; uname -s
printf 'os\t'; sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1
printf 'node\t'; (node --version 2>/dev/null || printf 'not_installed\n')
printf 'npm\t'; (npm --version 2>/dev/null || printf 'not_installed\n')
for service in postgresql mysql mariadb; do
  printf '%s\t' "$service"
  systemctl is-active "$service" 2>/dev/null || true
done
printf 'paths_begin\n'
find /srv /var/www /opt -maxdepth 5 -type f -name package.json -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' 2>/dev/null | head -n 40
printf 'paths_end\n'
`;

export function parseInventory(text: string): RemoteInventory {
  const values = new Map<string, string>();
  const paths: string[] = [];
  let inPaths = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw === "paths_begin") { inPaths = true; continue; }
    if (raw === "paths_end") { inPaths = false; continue; }
    const line = raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 1024);
    if (inPaths) { if (line.startsWith("/") && paths.length < 40) paths.push(line); continue; }
    const tab = line.indexOf("\t");
    if (tab > 0) values.set(line.slice(0, tab), line.slice(tab + 1).replace(/^"|"$/g, ""));
  }
  if (values.get("kernel") !== "Linux" || !values.get("user")) throw new Error("Не удалось подтвердить Linux-сервер и пользователя. Установка не выполнялась.");
  return { checkedAt: new Date().toISOString(), os: values.get("os") || "Не определена", kernel: "Linux", user: values.get("user")!,
    node: values.get("node") || "Не определен", npm: values.get("npm") || "Не определен", postgres: values.get("postgresql") || "Не определен",
    mysql: values.get("mysql") || "Не определен", mariadb: values.get("mariadb") || "Не определен", projectPaths: paths };
}

export class RemoteTargetService {
  private readonly file: string;
  private busy = false;
  constructor(private readonly root: string, private readonly factory: () => SshTransport = () => new (require("ssh2").Client)(),
    private readonly credentialResolver?: (target: RemoteTarget, auth: Credentials) => Promise<Credentials>) {
    this.file = path.join(root, "infra", "runtime", "remote-target.json");
  }
  async getTarget(): Promise<RemoteTarget> {
    try { return normalizeRemoteTarget(JSON.parse(await readFile(this.file, "utf8"))); } catch { return { ...emptyTarget }; }
  }
  async saveTarget(input: unknown): Promise<RemoteTarget> {
    const target = normalizeRemoteTarget(input);
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    // Only public connection fields are saved. Password/key/passphrase are deliberately not serialized.
    await writeFile(temporary, JSON.stringify(target, null, 2), { flag: "wx" });
    await rename(temporary, this.file);
    return target;
  }
  private async record(name: string, value: unknown): Promise<void> {
    const file = path.join(path.dirname(this.file), name);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
    await rename(temporary, file);
  }
  async getState(): Promise<{ target: RemoteTarget; inventory: RemoteInventory | null; preflight: UpdatePreflight | null }> {
    const target = await this.getTarget();
    const sameConnection = (saved: RemoteTarget) => saved?.host === target.host && saved.port === target.port &&
      saved.username === target.username && saved.fingerprint === target.fingerprint;
    let inventory: RemoteInventory | null = null;
    let preflight: UpdatePreflight | null = null;
    try {
      const saved = JSON.parse(await readFile(path.join(path.dirname(this.file), "remote-inventory.json"), "utf8"));
      if (sameConnection(saved.target) && saved.inventory?.kernel === "Linux" && typeof saved.inventory.checkedAt === "string" && Array.isArray(saved.inventory.projectPaths)) inventory = saved.inventory;
    } catch { /* A missing historical result does not block the application. */ }
    try {
      const saved = JSON.parse(await readFile(path.join(path.dirname(this.file), "remote-preflight.json"), "utf8"));
      if (sameConnection(saved.target) && saved.target.appPath === target.appPath && isUpdatePreflight(saved.preflight)) preflight = saved.preflight;
    } catch { /* No preflight has been completed for this exact target/path yet. */ }
    return { target, inventory, preflight };
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("SSH-проверка еще выполняется.");
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  async probe(input: unknown): Promise<{ fingerprint: string; checkedAt: string }> {
    const target = normalizeRemoteTarget(input);
    return this.exclusive(async () => {
      const client = this.factory();
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { reject(new Error("SSH-сервер не ответил за 12 секунд. Проверьте адрес и порт.")); client.destroy(); }, 12000);
          const finish = (error?: Error, fingerprint?: string) => { clearTimeout(timer); if (fingerprint) resolve({ fingerprint, checkedAt: new Date().toISOString() }); else reject(error); };
          client.on("error", () => finish(new Error("Не удалось получить ключ SSH-сервера. Проверьте сеть, порт и доступность SSH.")));
          client.on("close", () => finish(new Error("SSH-соединение закрыто до получения отпечатка.")));
          client.connect({ host: target.host, port: target.port, username: target.username, readyTimeout: 10000,
            hostVerifier: (key) => { finish(undefined, fingerprintOf(key)); return false; } });
        });
      } finally { client.destroy(); }
    });
  }
  async inspect(input: unknown, auth: Credentials): Promise<RemoteInventory> {
    const target = normalizeRemoteTarget(input);
    const text = await this.runReadOnly(target, auth, "sh -s", INVENTORY_SCRIPT);
    const inventory = parseInventory(text);
    await this.record("remote-inventory.json", { target, inventory });
    return inventory;
  }
  async preflight(input: unknown, auth: Credentials): Promise<UpdatePreflight> {
    const target = normalizeRemoteTarget(input);
    if (!target.appPath) throw new Error("Укажите каталог существующей LMS для предварительной проверки.");
    const script = await readFile(path.join(this.root, "infra", "scripts", "lms-update-preflight.cjs"), "utf8");
    const payload = Buffer.from(JSON.stringify({ appPath: target.appPath })).toString("base64");
    const text = await this.runReadOnly(target, auth, `node - '${payload}'`, script);
    let result: UpdatePreflight;
    try {
      result = JSON.parse(text);
      if (!isUpdatePreflight(result)) throw new Error("Invalid preflight response");
    } catch { throw new Error("Сервер вернул неполный результат подготовки. Обновление не выполнялось."); }
    await this.record("remote-preflight.json", { target, preflight: result });
    return result;
  }
  private async runReadOnly(target: RemoteTarget, auth: Credentials, command: string, script: string): Promise<string> {
    return this.withSession(target, auth, (session) => session.execute(command, script));
  }
  // Only trusted main-process services receive this session; it is never exposed through IPC.
  async withSession<T>(target: RemoteTarget, auth: Credentials, operation: (session: RemoteSession) => Promise<T>, independent = false): Promise<T> {
    if (!target.fingerprint) throw new Error("Сначала сверьте отпечаток сервера через консоль хостера и укажите подтвержденное значение. Пароль пока не отправлялся.");
    if (!auth || !["password", "key"].includes(auth.mode)) throw new Error("Выберите способ SSH-входа.");
    if (auth.savedForClient) {
      if (!this.credentialResolver) throw Error("Сохраненный SSH-доступ не настроен.");
      auth = await this.credentialResolver(target, auth);
    }
    const credentials: { password?: string; privateKey?: Buffer; passphrase?: string } = {};
    if (auth.mode === "password") {
      if (typeof auth.password !== "string" || !auth.password || auth.password.length > 16384) throw new Error("Введите SSH-пароль в приложении.");
      credentials.password = auth.password;
    } else {
      if (typeof auth.identityFile !== "string" || !path.isAbsolute(auth.identityFile) || /\.pub$/i.test(auth.identityFile) ||
          (await stat(auth.identityFile)).size > 512 * 1024) throw new Error("Выберите файл приватного SSH-ключа сервера, не .pub.");
      credentials.privateKey = await readFile(auth.identityFile);
      if (typeof auth.passphrase === "string") credentials.passphrase = auth.passphrase;
    }
    const connect = async () => {
      const client = this.factory();
      let changed = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { reject(connectionFailure({ level: "client-timeout" }, changed)); client.destroy(); }, 35000);
          const fail = (error?: unknown) => { clearTimeout(timer); reject(connectionFailure(error, changed)); };
          client.on("error", fail);
          client.on("close", fail);
          client.once("ready", () => { clearTimeout(timer); resolve(); });
          client.connect({ host: target.host, port: target.port, username: target.username, readyTimeout: 30000, keepaliveInterval: 5000, keepaliveCountMax: 2,
            ...credentials, hostVerifier: (key) => { const matches = fingerprintOf(key) === target.fingerprint; changed = !matches; return matches; } });
        });
        const session: RemoteSession = { execute: (command, input = "", timeout = 45000) => new Promise<string>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => finish(new Error("SSH-операция превысила время ожидания. Если обновление уже началось, проверьте его результат повторным подключением.")), timeout);
          const disconnected = () => finish(new Error("SSH-соединение прервано. Серверная задача могла продолжить работу; проверьте её результат перед повтором."));
          const finish = (error?: Error, value = "") => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.removeListener("close", disconnected);
            if (error) reject(error); else resolve(value);
          };
          client.once("close", disconnected);
          client.exec(command, (error, channel) => {
            if (error) { finish(new Error("Сервер не выполнил команду Core.")); return; }
            let output = "";
            channel.on("data", (data: Buffer) => {
              output += data.toString("utf8");
              if (Buffer.byteLength(output) > 65536) { finish(new Error("Ответ сервера слишком большой.")); channel.destroy?.(); }
            });
            channel.stderr.on("data", () => { /* Raw stderr may contain secrets; only safe worker status is returned. */ });
            channel.on("error", () => finish(new Error("Ошибка SSH-канала Core.")));
            channel.on("close", (code: number) => code === 0 ? finish(undefined, output) : finish(new Error("Сервер не завершил команду Core. Проверьте сохранённый результат операции.")));
            channel.end(input);
          });
        }), openLoopback: (port) => new Promise<Duplex>((resolve, reject) => {
          if (!Number.isInteger(port) || port < 1024 || port > 65535 || !client.forwardOut) { reject(new Error("Некорректный web-порт SSH-просмотра.")); return; }
          const timer = setTimeout(() => reject(new Error("Веб-служба не ответила через SSH.")), 10000);
          client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => { clearTimeout(timer); if (error) reject(new Error("Веб-служба недоступна через SSH.")); else resolve(channel); });
        }), onClose: (callback) => { client.once("close", callback); return () => { client.removeListener("close", callback); }; } };
        return await operation(session);
      } finally {
        client.destroy();
        credentials.privateKey?.fill(0);
        delete credentials.password;
        delete credentials.passphrase;
        delete auth.password;
        delete auth.passphrase;
      }
    };
    return independent ? connect() : this.exclusive(connect);
  }
}
