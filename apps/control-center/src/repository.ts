import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RepositoryConfig = {
  url: string;
  branch: string;
  identityMode: "default" | "file" | "managed";
  identityFile: string;
};

export type RepositoryResult = {
  status: "connected" | "auth_error" | "host_untrusted" | "host_changed" | "branch_missing" |
    "branch_required" | "empty_repository" | "network_error" | "tool_missing" | "invalid_config" | "error";
  canRead: boolean;
  checkedAt: string;
  message: string;
  defaultBranch: string | null;
  selectedBranch: string | null;
  revision: string | null;
  branches: string[];
};

type SavedRepository = { config: RepositoryConfig; result: RepositoryResult | null };
export type KeyInfo = { available: boolean; publicKey: string; fingerprint: string };
export type KeyProtector = {
  available: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (encrypted: Buffer) => string;
};
export type RepositoryRunner = (file: string, args: string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean;
}) => Promise<{ stdout: string; stderr: string }>;
export type GitReadCommand = (args: string[], timeout?: number, maxBuffer?: number) => Promise<{ stdout: string; stderr: string }>;

const blankConfig: RepositoryConfig = { url: "", branch: "", identityMode: "default", identityFile: "" };

function isSavedResult(input: unknown): input is RepositoryResult {
  if (!input || typeof input !== "object") return false;
  const result = input as Record<string, unknown>;
  const states = ["connected", "auth_error", "host_untrusted", "host_changed", "branch_missing", "branch_required",
    "empty_repository", "network_error", "tool_missing", "invalid_config", "error"];
  return states.includes(String(result.status)) && typeof result.canRead === "boolean" &&
    typeof result.checkedAt === "string" && Number.isFinite(Date.parse(result.checkedAt)) &&
    typeof result.message === "string" && result.message.length <= 2048 &&
    [result.defaultBranch, result.selectedBranch, result.revision].every((value) => value === null || typeof value === "string") &&
    Array.isArray(result.branches) && result.branches.length <= 20000 &&
    result.branches.every((value) => typeof value === "string" && value.length <= 1024);
}

export function normalizeRepositoryConfig(input: unknown): RepositoryConfig {
  if (!input || typeof input !== "object") throw new Error("Введите параметры репозитория.");
  const raw = input as Record<string, unknown>;
  if (typeof raw.url !== "string" || typeof raw.branch !== "string" ||
      !["default", "file", "managed"].includes(String(raw.identityMode))) {
    throw new Error("Некорректные параметры репозитория.");
  }
  const url = raw.url.trim();
  if (/^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-|SHA256:|-----BEGIN)/i.test(url)) {
    throw new Error("Здесь нужен адрес репозитория git@github.com:owner/repository.git, а не SSH-ключ. Публичный ключ добавляется в поле Key в GitHub Deploy keys.");
  }
  if (url.length > 2048 || /[\s%\x00-\x1f\x7f]/.test(url)) throw new Error("Введите SSH-адрес без пробелов, закодированных путей и управляющих символов.");
  let repositoryPath = "";
  if (url.startsWith("ssh://")) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ssh:" || parsed.password || parsed.search || parsed.hash ||
        !/^[a-z0-9_][a-z0-9_.-]*$/i.test(parsed.username) ||
        !/^[a-z0-9][a-z0-9.-]*$/i.test(parsed.hostname) ||
        (parsed.port && (Number(parsed.port) < 1 || Number(parsed.port) > 65535))) {
      throw new Error("Нужен SSH-адрес без пароля, параметров и перенаправлений.");
    }
    repositoryPath = parsed.pathname.slice(1);
    // URL normalizes dot segments, so reject them in the original input as well.
    if (/\/(?:\.|\.\.)(?:\/|$)/.test(url)) throw new Error("Некорректный путь репозитория.");
  } else {
    const match = /^([a-z0-9_][a-z0-9_.-]*)@([a-z0-9][a-z0-9.-]*):(.+)$/i.exec(url);
    if (!match) throw new Error("Используйте SSH-адрес вида git@github.com:owner/repository.git.");
    repositoryPath = match[3];
  }
  if (!repositoryPath || repositoryPath.split("/").some((part) =>
    !/^[a-z0-9_][a-z0-9_.-]*$/i.test(part) || part === "." || part === "..")) {
    throw new Error("В SSH-адресе указан некорректный путь репозитория.");
  }
  const branch = raw.branch.trim();
  if (branch.length > 255 || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
      branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") ||
      branch.includes("..") || branch.includes("@{") || branch.includes("//") || branch === "@" ||
      branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    throw new Error("Некорректное имя ветки.");
  }
  const identityMode = raw.identityMode as RepositoryConfig["identityMode"];
  const identityFile = identityMode === "file" && typeof raw.identityFile === "string" ? raw.identityFile.trim() : "";
  if (identityMode === "file" && (!path.isAbsolute(identityFile) || /[\x00-\x1f\x7f"%]/.test(identityFile) || identityFile.toLowerCase().endsWith(".pub"))) {
    throw new Error("Выберите файл приватного ключа, не публичный .pub. Содержимое ключа вводить не нужно.");
  }
  return { url, branch, identityMode, identityFile };
}

export function parseRemoteRefs(stdout: string, branch: string): Omit<RepositoryResult, "checkedAt"> {
  let defaultBranch: string | null = null;
  const heads = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const symbolic = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line);
    if (symbolic) defaultBranch = symbolic[1];
    const ref = /^([a-f0-9]{40}|[a-f0-9]{64})\trefs\/heads\/(.+)$/i.exec(line);
    if (ref) heads.set(ref[2], ref[1].toLowerCase());
    if (!symbolic && !ref && !/^([a-f0-9]{40}|[a-f0-9]{64})\tHEAD$/i.test(line)) {
      return { status: "error", canRead: false, message: "Git вернул непонятный ответ. Чтение репозитория не подтверждено.", defaultBranch: null, selectedBranch: null, revision: null, branches: [] };
    }
  }
  const branches = [...heads.keys()].sort();
  const selectedBranch = branch || defaultBranch;
  const revision = selectedBranch ? heads.get(selectedBranch) || null : null;
  if (!branches.length) {
    return { status: "empty_repository", canRead: true, message: "Доступ подтвержден, но в репозитории нет веток с кодом.", defaultBranch, selectedBranch, revision: null, branches };
  }
  if (!selectedBranch) {
    return { status: "branch_required", canRead: true, message: "Репозиторий прочитан. Выберите ветку: основная ветка не объявлена.", defaultBranch, selectedBranch: null, revision: null, branches };
  }
  if (!revision) {
    return { status: "branch_missing", canRead: true, message: "Репозиторий прочитан, но выбранная ветка не найдена.", defaultBranch, selectedBranch, revision: null, branches };
  }
  return { status: "connected", canRead: true, message: "Core прочитал репозиторий и подтвердил выбранную ветку. Код не загружался и не изменялся.", defaultBranch, selectedBranch, revision, branches };
}

export function repositoryFailure(error: unknown): Pick<RepositoryResult, "status" | "message" | "canRead"> {
  const failure = error as { stderr?: string; message?: string; code?: string | number; killed?: boolean };
  const text = `${failure?.stderr || ""}\n${failure?.message || ""}`;
  if (failure?.code === "ENOENT") return { status: "tool_missing", canRead: false, message: "Не найдены Git или OpenSSH. Проверьте установленное окружение." };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key/i.test(text)) return { status: "host_changed", canRead: false, message: "Ключ SSH-хоста изменился. Подключение остановлено; старое доверие не удалялось." };
  if (/Host key verification failed|No .* host key is known/i.test(text)) return { status: "host_untrusted", canRead: false, message: "Ключ SSH-хоста еще не подтвержден для Core. Проверка доступа не выполнялась." };
  if (/Permission denied|invalid format|incorrect passphrase|error in libcrypto|sign_and_send_pubkey/i.test(text)) return { status: "auth_error", canRead: false, message: "SSH-ключ не принят или не разблокирован. Проверьте ключ и его доступ в GitHub; не отправляйте приватный ключ в чат." };
  if (failure?.killed || /timed out|Could not resolve|Connection refused|No route|Network is unreachable|resolve hostname/i.test(text)) return { status: "network_error", canRead: false, message: "SSH-проверка не завершилась вовремя или сервер недоступен. Проверьте сеть и адрес." };
  if (/Repository not found|does not appear to be a git repository/i.test(text)) return { status: "error", canRead: false, message: "Репозиторий не найден либо выбранному ключу не разрешено его читать." };
  return { status: "error", canRead: false, message: "Git не подтвердил чтение репозитория. Проверьте адрес, ключ и права доступа." };
}

export class RepositoryService {
  private readonly runtime: string;
  private readonly sshDirectory: string;
  private readonly keyDirectory: string;
  private readonly stateFile: string;
  private busy = false;

  constructor(private readonly root: string, private readonly tools: {
    git: string; ssh: string; keygen: string;
  }, private readonly protector: KeyProtector, private readonly runner: RepositoryRunner = async (file, args, options) =>
    execFileAsync(file, args, options)) {
    this.runtime = path.join(root, "infra", "runtime");
    this.sshDirectory = path.join(this.runtime, "ssh");
    this.keyDirectory = path.join(this.sshDirectory, "keys");
    this.stateFile = path.join(this.runtime, "repository-connection.json");
  }

  async getState(): Promise<SavedRepository & { key: KeyInfo }> {
    let saved: SavedRepository = { config: { ...blankConfig }, result: null };
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as SavedRepository;
      saved = { config: normalizeRepositoryConfig(parsed.config), result: isSavedResult(parsed.result) ? parsed.result : null };
    } catch {
      // An absent or damaged connection file must not prevent the app from opening.
    }
    return { ...saved, key: await this.getManagedKey() };
  }

  async getManagedKey(): Promise<KeyInfo> {
    const encrypted = path.join(this.keyDirectory, "repository.private.encrypted");
    const publicFile = path.join(this.keyDirectory, "repository.pub");
    if (!existsSync(encrypted) || !existsSync(publicFile)) return { available: false, publicKey: "", fingerprint: "" };
    const publicKey = (await readFile(publicFile, "utf8")).trim();
    const keyData = publicKey.split(/\s+/)[1];
    if (!publicKey.startsWith("ssh-ed25519 ") || !keyData || !/^[a-z0-9+/]+={0,2}$/i.test(keyData) ||
        Buffer.from(keyData, "base64").length !== 51) {
      throw new Error("Публичный ключ Core поврежден. Старые файлы не изменялись.");
    }
    return { available: true, publicKey, fingerprint: `SHA256:${createHash("sha256").update(Buffer.from(keyData, "base64")).digest("base64").replace(/=+$/, "")}` };
  }

  private async restrictDirectory(directory: string): Promise<void> {
    if (process.platform !== "win32") { await chmod(directory, 0o700); return; }
    const identity = await this.runner("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      cwd: this.root, timeout: 5000, windowsHide: true, maxBuffer: 16384
    });
    const sid = /S-1-\d+(?:-\d+)+/.exec(identity.stdout)?.[0];
    if (!sid) throw new Error("Не удалось определить учетную запись для защиты ключа.");
    await this.runner("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], {
      cwd: this.root, timeout: 5000, windowsHide: true, maxBuffer: 16384
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Другая операция с репозиторием еще выполняется.");
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  private async removeTemporaryDirectory(directory: string): Promise<void> {
    if (path.dirname(path.resolve(directory)) !== path.resolve(this.keyDirectory) ||
        !path.basename(directory).startsWith("session-")) throw new Error("Небезопасный путь временного ключа.");
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  async createManagedKey(): Promise<KeyInfo> {
    return this.exclusive(async () => {
      const existing = await this.getManagedKey();
      if (existing.available) return existing;
      if (existsSync(path.join(this.keyDirectory, "repository.private.encrypted")) ||
          existsSync(path.join(this.keyDirectory, "repository.pub"))) {
        throw new Error("Обнаружена неполная пара ключей Core. Файлы сохранены без перезаписи; требуется проверка.");
      }
      if (!this.protector.available()) throw new Error("Защищенное хранилище Windows недоступно. Незашифрованный ключ не будет сохранен.");
      await mkdir(this.keyDirectory, { recursive: true, mode: 0o700 });
      await this.restrictDirectory(this.keyDirectory);
      const temporary = await mkdtemp(path.join(this.keyDirectory, "session-"));
      const privateFile = path.join(temporary, "identity");
      try {
        await this.runner(this.tools.keygen, ["-q", "-t", "ed25519", "-N", "", "-C", "LMS Core repository read access", "-f", privateFile], {
          cwd: this.root, timeout: 15000, windowsHide: true, maxBuffer: 16384
        });
        const privateKey = await readFile(privateFile, "utf8");
        const encrypted = this.protector.encrypt(privateKey);
        if (this.protector.decrypt(encrypted) !== privateKey) throw new Error("Не удалось проверить шифрование ключа.");
        const publicKey = await readFile(`${privateFile}.pub`, "utf8");
        await writeFile(path.join(this.keyDirectory, "repository.private.encrypted"), encrypted, { flag: "wx", mode: 0o600 });
        await writeFile(path.join(this.keyDirectory, "repository.pub"), publicKey, { flag: "wx", mode: 0o600 });
        return await this.getManagedKey();
      } finally {
        await this.removeTemporaryDirectory(temporary);
      }
    });
  }

  async check(input: unknown): Promise<SavedRepository & { key: KeyInfo }> {
    return this.exclusive(async () => {
      const config = normalizeRepositoryConfig(input);
      const checkId = randomUUID();
      let result: RepositoryResult;
      try {
        result = await this.withTransport(config, async (git) => {
          try {
            const output = await git(["ls-remote", "--symref", "--exit-code", "--", config.url, "HEAD", "refs/heads/*"]);
            return { ...parseRemoteRefs(output.stdout, config.branch), checkedAt: new Date().toISOString() };
          } catch (error) {
            const failure = error as { code?: number; stdout?: string };
            if (failure.code === 2 && !failure.stdout?.trim()) {
              return { ...parseRemoteRefs("", config.branch), checkedAt: new Date().toISOString() };
            }
            return { ...repositoryFailure(error), checkedAt: new Date().toISOString(), defaultBranch: null, selectedBranch: null, revision: null, branches: [] };
          }
        });
      } catch {
        result = { status: "invalid_config", canRead: false, checkedAt: new Date().toISOString(),
          message: "Не удалось подготовить выбранный ключ или защищенные файлы подключения. Проверьте настройки ключа.",
          defaultBranch: null, selectedBranch: null, revision: null, branches: [] };
      }
      const saved: SavedRepository = { config, result };
      const temporaryState = `${this.stateFile}.${checkId}.tmp`;
      await writeFile(temporaryState, JSON.stringify(saved, null, 2));
      await rename(temporaryState, this.stateFile);
      return { ...saved, key: await this.getManagedKey() };
    });
  }

  async withReadAccess<T>(input: unknown, operation: (config: RepositoryConfig, git: GitReadCommand) => Promise<T>): Promise<T> {
    const config = normalizeRepositoryConfig(input);
    return this.exclusive(() => this.withTransport(config, (git) => operation(config, git)));
  }

  private async withTransport<T>(config: RepositoryConfig, operation: (git: GitReadCommand) => Promise<T>): Promise<T> {
    await mkdir(this.sshDirectory, { recursive: true });
    const checkId = randomUUID();
    const sshConfigFile = path.join(this.sshDirectory, `check-${checkId}.conf`);
    const gitConfigFile = path.join(this.sshDirectory, "git-check.config");
    let temporary: string | null = null;
    try {
      let identity = config.identityFile;
      if (config.identityMode === "managed") {
        if (!this.protector.available() || !(await this.getManagedKey()).available) throw new Error("Защищенный ключ Core недоступен.");
        const encrypted = await readFile(path.join(this.keyDirectory, "repository.private.encrypted"));
        const plain = this.protector.decrypt(encrypted);
        temporary = await mkdtemp(path.join(this.keyDirectory, "session-"));
        identity = path.join(temporary, "identity");
        await writeFile(identity, plain, { mode: 0o600, flag: "wx" });
      } else if (config.identityMode === "file") {
        if (!(await stat(identity)).isFile()) throw new Error("Выбранный файл ключа недоступен.");
      }
      const settings = [
        "Host *", "  BatchMode yes", "  StrictHostKeyChecking yes",
        "  UserKnownHostsFile ssh/known_hosts", "  GlobalKnownHostsFile none",
        "  UpdateHostKeys no", "  ConnectTimeout 8", "  ConnectionAttempts 1",
        "  ServerAliveInterval 5", "  ServerAliveCountMax 1",
        "  PasswordAuthentication no", "  KbdInteractiveAuthentication no",
        "  PreferredAuthentications publickey"
      ];
      if (identity) settings.push(`  IdentityFile "${identity.replace(/\\/g, "/")}"`, "  IdentitiesOnly yes");
      await writeFile(sshConfigFile, `${settings.join("\n")}\n`, { flag: "wx" });
      await writeFile(gitConfigFile, "");
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of Object.keys(env)) {
        if (/^GIT_|^SSH_ASKPASS/i.test(name)) delete env[name];
      }
      Object.assign(env, {
        GIT_TERMINAL_PROMPT: "0", GIT_SSH_VARIANT: "ssh", GIT_ALLOW_PROTOCOL: "ssh",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfigFile, GIT_ATTR_NOSYSTEM: "1",
        GIT_CEILING_DIRECTORIES: this.root, GIT_LFS_SKIP_SMUDGE: "1",
        GIT_SSH_COMMAND: `"${this.tools.ssh.replace(/\\/g, "/")}" -F ssh/check-${checkId}.conf`
      });
      return await operation((args, timeout = 25000, maxBuffer = 2 * 1024 * 1024) =>
        this.runner(this.tools.git, args, { cwd: this.runtime, env, timeout, maxBuffer, windowsHide: true }));
    } finally {
      await rm(sshConfigFile, { force: true });
      if (temporary) await this.removeTemporaryDirectory(temporary);
    }
  }
}
