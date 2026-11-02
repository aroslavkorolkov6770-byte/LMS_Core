import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Credentials, normalizeRemoteTarget, RemoteTarget } from "./remote-target";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type Protector = { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string };
type Stored = { version: 1; clientId: string; revision: number; target: RemoteTarget | null; passwords: Record<string, string> };
export type ClientServerProfile = { clientId: string; revision: number; target: RemoteTarget | null; passwordSaved: boolean };

export function serverCredentialId(target: RemoteTarget): string {
  const value = normalizeRemoteTarget(target);
  // Paths may change without changing the SSH account; a new host key must never reuse its password.
  return createHash("sha256").update(JSON.stringify([value.host.toLowerCase(), value.port, value.username, value.fingerprint])).digest("hex");
}

export class ClientServerStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly protector: Protector) {}
  private file(clientId: string): string {
    if (!UUID.test(clientId)) throw Error("Сначала выберите сохраненного клиента.");
    return path.join(this.directory, `${clientId.toLowerCase()}.json`);
  }
  private async read(clientId: string): Promise<Stored> {
    const file = this.file(clientId);
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error("INVALID_SERVER_PROFILE_DIRECTORY");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw Error("INVALID_SERVER_PROFILE");
      const value = JSON.parse(await readFile(file, "utf8")) as Stored;
      if (value.version !== 1 || value.clientId !== clientId || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
          !value.passwords || typeof value.passwords !== "object" || Array.isArray(value.passwords) || Object.keys(value.passwords).length > 20 ||
          Object.entries(value.passwords).some(([key, secret]) => !/^[a-f0-9]{64}$/.test(key) || typeof secret !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(secret) || secret.length > 48000)) throw Error("INVALID_SERVER_PROFILE");
      return { version: 1, clientId, revision: value.revision, target: value.target === null ? null : normalizeRemoteTarget(value.target), passwords: value.passwords };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, clientId, revision: 0, target: null, passwords: {} };
      throw Error("Профиль сервера поврежден или недоступен. Он не перезаписан; восстановите доступ к профилю Windows.");
    }
  }
  private public(value: Stored, target = value.target): ClientServerProfile {
    return { clientId: value.clientId, revision: value.revision, target: value.target,
      passwordSaved: !!target && Object.hasOwn(value.passwords, serverCredentialId(target)) };
  }
  async get(clientId: string, input?: unknown): Promise<ClientServerProfile> {
    await this.queue;
    const value = await this.read(clientId);
    return this.public(value, input === undefined ? value.target : normalizeRemoteTarget(input));
  }
  private update(clientId: string, revision: number, change: (value: Stored) => void): Promise<ClientServerProfile> {
    const operation = this.queue.then(async () => {
      const value = await this.read(clientId);
      if (value.revision !== revision) throw Error("Профиль сервера изменился. Перечитайте его перед сохранением; пароль не изменен.");
      const previous = JSON.stringify(value);
      change(value);
      if (JSON.stringify(value) === previous) return this.public(value);
      value.revision++;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.directory)).isSymbolicLink()) throw Error("Каталог профилей не должен быть ссылкой.");
      const file = this.file(clientId), temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
        await rename(temporary, file);
      } finally { try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      return this.public(value);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  saveTarget(clientId: string, input: unknown, revision: number): Promise<ClientServerProfile> {
    const target = normalizeRemoteTarget(input);
    return this.update(clientId, revision, (value) => { value.target = target; });
  }
  remember(clientId: string, input: unknown, password: unknown, revision: number): Promise<ClientServerProfile> {
    const target = normalizeRemoteTarget(input);
    if (!target.fingerprint) throw Error("Сначала независимо подтвердите SSH-отпечаток сервера.");
    if (typeof password !== "string" || !password || password.length > 16384 || password.includes("\0")) throw Error("Введите пароль сервера перед нажатием замка.");
    if (!this.protector.available()) throw Error("Защищенное хранилище Windows недоступно. Пароль не сохранен.");
    return this.update(clientId, revision, (value) => {
      const binding = serverCredentialId(target);
      if (!Object.hasOwn(value.passwords, binding) && Object.keys(value.passwords).length >= 20) throw Error("Сохранено 20 серверных доступов клиента. Удалите ненужный сохраненный пароль.");
      try { value.passwords[binding] = this.protector.encrypt(JSON.stringify({ version: 1, clientId, binding, password })).toString("base64"); }
      catch { throw Error("Хранилище Windows не смогло зашифровать пароль. Прежний доступ не изменен."); }
      value.target = target;
    });
  }
  forget(clientId: string, input: unknown, revision: number): Promise<ClientServerProfile> {
    const target = normalizeRemoteTarget(input);
    return this.update(clientId, revision, (value) => { delete value.passwords[serverCredentialId(target)]; value.target = target; });
  }
  async credentials(input: RemoteTarget, auth: Credentials): Promise<Credentials> {
    if (!auth.savedForClient) return auth;
    if (auth.mode !== "password" || auth.password) throw Error("Выберите сохраненный доступ либо введите пароль вручную.");
    const target = normalizeRemoteTarget(input), binding = serverCredentialId(target);
    if (!target.fingerprint || !this.protector.available()) throw Error("Защищенный SSH-доступ недоступен; пароль не отправлен.");
    await this.queue;
    const value = await this.read(auth.savedForClient);
    const encrypted = value.passwords[binding];
    if (!encrypted) throw Error("Для этого клиента, сервера и SSH-отпечатка пароль не сохранен.");
    try {
      const secret = JSON.parse(this.protector.decrypt(Buffer.from(encrypted, "base64")));
      if (secret.version !== 1 || secret.clientId !== auth.savedForClient || secret.binding !== binding || typeof secret.password !== "string" || !secret.password || secret.password.length > 16384) throw Error("CREDENTIAL_BINDING_MISMATCH");
      return { mode: "password", password: secret.password };
    } catch { throw Error("Не удалось расшифровать сохраненный SSH-доступ. Введите пароль заново и сохраните замком."); }
  }
  async remove(clientId: string): Promise<void> {
    const operation = this.queue.then(async () => {
      await this.read(clientId);
      try { await unlink(this.file(clientId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
