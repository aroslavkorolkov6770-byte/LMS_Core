import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Credentials, RemoteTarget } from "./remote-target";

type Protector = { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string };
export type InstallationAccess = {
  clientAdminName: string; clientAdminLogin: string; clientAdminPassword: string;
  systemAdminLogin: string; systemAdminPassword: string;
  host: string; sshUsername: string; sshPort: number; sshPassword: string;
  databaseMode: "local_peer" | "manual"; databaseHost: string; databasePort: number; databaseUser: string; databasePassword: string;
};
type Stored = { clientId: string; revision: number; values: InstallationAccess };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const secretKeys = ["clientAdminPassword", "systemAdminPassword", "sshPassword", "databasePassword"] as const;
const login = /^[a-z0-9][a-z0-9_.@+-]{0,119}$/i;
const validHost = (value: string) => !value || /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(value) && !value.includes("..");

export class ClientInstallationAccessStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly protector: Protector) {}
  available(): boolean { return this.protector.available(); }
  private file(clientId: string) {
    if (!UUID.test(clientId)) throw Error("Выберите сохраненного клиента.");
    return path.join(this.directory, clientId + ".json");
  }
  validate(input: InstallationAccess): InstallationAccess {
    const keys = ["clientAdminName", "clientAdminLogin", "clientAdminPassword", "systemAdminLogin", "systemAdminPassword", "host", "sshUsername", "sshPort", "sshPassword", "databaseMode", "databaseHost", "databasePort", "databaseUser", "databasePassword"] as const;
    const value = Object.fromEntries(keys.map(key => [key, input?.[key]])) as InstallationAccess;
    if (!value || !login.test(value.clientAdminLogin) || !login.test(value.systemAdminLogin) || value.clientAdminLogin.toLowerCase() === value.systemAdminLogin.toLowerCase()) throw Error("Укажите разные логины администраторов без пробелов, до 120 символов.");
    if (typeof value.clientAdminName !== "string" || !value.clientAdminName.trim() || value.clientAdminName.length > 150) throw Error("Укажите имя администратора до 150 символов.");
    value.clientAdminName = value.clientAdminName.trim();
    if (typeof value.host !== "string" || !validHost(value.host) || typeof value.databaseHost !== "string" || !validHost(value.databaseHost) || !/^[a-z_][a-z0-9_-]{0,63}$/i.test(value.sshUsername) || ![value.sshPort, value.databasePort].every(p => Number.isInteger(p) && p > 0 && p <= 65535) || !["local_peer", "manual"].includes(value.databaseMode) || typeof value.databaseUser !== "string" || value.databaseUser.length > 128) throw Error("Проверьте адреса, пользователей и порты серверов.");
    for (const key of secretKeys) {
      if (typeof value[key] !== "string" || value[key].includes("\0") || value[key].length > (key === "sshPassword" ? 16384 : key === "databasePassword" ? 4096 : 128) || key.endsWith("AdminPassword") && value[key] && value[key].length < 12) throw Error("Пароли LMS: 12–128 символов. Проверьте длину введенных доступов.");
    }
    if (value.sshPassword && !value.host || value.databaseMode === "manual" && (!value.databaseHost || !value.databaseUser)) throw Error("Укажите адрес сервера для сохранения его пароля.");
    return value;
  }
  private async read(clientId: string): Promise<Stored | null> {
    const file = this.file(clientId);
    try {
      const directory = await lstat(this.directory), stat = await lstat(file);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw Error();
      const raw = JSON.parse(await readFile(file, "utf8"));
      if (raw.version !== 1 || raw.clientId !== clientId || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || typeof raw.ciphertext !== "string" || !this.protector.available()) throw Error();
      const decoded = JSON.parse(this.protector.decrypt(Buffer.from(raw.ciphertext, "base64")));
      if (decoded.clientId !== clientId || decoded.revision !== raw.revision) throw Error();
      return { clientId, revision: raw.revision, values: this.validate(decoded.values) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw Error("Защищенные доступы недоступны или повреждены; прежняя запись не перезаписана.");
    }
  }
  async get(clientId: string) {
    await this.queue;
    const stored = await this.read(clientId);
    if (!stored) return { clientId, revision: 0, values: null, saved: { clientAdminPassword: false, systemAdminPassword: false, sshPassword: false, databasePassword: false } };
    const values = { ...stored.values } as Partial<InstallationAccess>;
    const saved = Object.fromEntries(secretKeys.map(key => [key, Boolean(values[key])])) as Record<typeof secretKeys[number], boolean>;
    for (const key of secretKeys) delete values[key];
    return { clientId, revision: stored.revision, values, saved };
  }
  save(clientId: string, input: InstallationAccess, revision: number) {
    const value = this.validate(input);
    const operation = this.queue.then(async () => {
      const old = await this.read(clientId);
      if ((old?.revision || 0) !== revision) throw Error("Доступы изменились в другом окне. Перечитайте карточку; запись не изменена.");
      const next = { ...value };
      // Empty inputs retain only the same account's secret, never another host or login's password.
      if (old) {
        if (!next.clientAdminPassword && next.clientAdminLogin === old.values.clientAdminLogin) next.clientAdminPassword = old.values.clientAdminPassword;
        if (!next.systemAdminPassword && next.systemAdminLogin === old.values.systemAdminLogin) next.systemAdminPassword = old.values.systemAdminPassword;
        if (!next.sshPassword && ["host", "sshUsername", "sshPort"].every(key => next[key as keyof InstallationAccess] === old.values[key as keyof InstallationAccess])) next.sshPassword = old.values.sshPassword;
        if (!next.databasePassword && ["databaseMode", "databaseHost", "databasePort", "databaseUser"].every(key => next[key as keyof InstallationAccess] === old.values[key as keyof InstallationAccess])) next.databasePassword = old.values.databasePassword;
      }
      if (next.databaseMode === "local_peer") next.databasePassword = "";
      if (!this.protector.available()) throw Error("Хранилище Windows недоступно. Открытым текстом пароль не сохраняется.");
      const nextRevision = revision + 1;
      const ciphertext = this.protector.encrypt(JSON.stringify({ clientId, revision: nextRevision, values: next })).toString("base64");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.directory)).isSymbolicLink()) throw Error("Каталог доступов не должен быть ссылкой.");
      const file = this.file(clientId), temporary = file + "." + randomUUID() + ".tmp";
      try { await writeFile(temporary, JSON.stringify({ version: 1, clientId, revision: nextRevision, ciphertext }), { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
      finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    });
    this.queue = operation.catch(() => undefined);
    return operation.then(() => this.get(clientId));
  }
  async sshSaved(clientId: string, target: RemoteTarget): Promise<boolean> {
    await this.queue;
    const stored = await this.read(clientId);
    return Boolean(stored?.values.sshPassword && stored.values.host.toLowerCase() === target.host.toLowerCase() && stored.values.sshPort === target.port && stored.values.sshUsername === target.username);
  }
  async sshCredentials(target: RemoteTarget, auth: Credentials): Promise<Credentials> {
    if (!auth.savedForClient || auth.mode !== "password" || auth.password || !target.fingerprint || !await this.sshSaved(auth.savedForClient, target)) throw Error("Сохраненный SSH-доступ не соответствует выбранному клиенту и серверу.");
    const stored = await this.read(auth.savedForClient);
    return { mode: "password", password: stored!.values.sshPassword };
  }
  async resolve(clientId: string, input: Record<string, any>, canonical: { clientAdminLogin: string; systemAdminLogin: string }) {
    const result = { ...input };
    delete result.useSavedAccess;
    if (!input.useSavedAccess) return result;
    await this.queue;
    const stored = await this.read(clientId);
    if (!stored || stored.values.clientAdminLogin !== canonical.clientAdminLogin || stored.values.systemAdminLogin !== canonical.systemAdminLogin || input.clientAdminLogin !== canonical.clientAdminLogin || input.systemAdminLogin !== canonical.systemAdminLogin) throw Error("Сохраните доступы выбранного клиента в его карточке. Старые хеши паролей нельзя использовать для установки.");
    for (const key of ["clientAdminPassword", "systemAdminPassword"] as const) if (!result[key]) result[key] = stored.values[key];
    if (result.maintenanceUrl) {
      const url = new URL(result.maintenanceUrl);
      if (!url.password && stored.values.databaseMode === "manual" && url.hostname === stored.values.databaseHost && Number(url.port || 5432) === stored.values.databasePort && decodeURIComponent(url.username) === stored.values.databaseUser) { url.password = stored.values.databasePassword; result.maintenanceUrl = url.href; }
    }
    return result;
  }
  async remove(clientId: string) { await this.queue; await unlink(this.file(clientId)).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  async forgetSsh(clientId: string) { const old = await this.get(clientId); if (!old.values) return; const stored = await this.read(clientId); stored!.values.sshPassword = ""; stored!.values.host = ""; await this.save(clientId, stored!.values, old.revision); }
}
