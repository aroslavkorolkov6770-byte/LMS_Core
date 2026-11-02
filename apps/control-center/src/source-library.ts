import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeRepositoryConfig, RepositoryConfig } from "./repository";

export type SourceEntry = { id: string; name: string; url: string; branch: string; note: string; createdAt: string; updatedAt: string };
export type SourceLibrary = { version: 1; revision: number; sources: SourceEntry[] };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function sourceFields(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Заполните поля источника.");
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const note = typeof raw.note === "string" ? raw.note.replace(/\r\n?/g, "\n").trim() : "";
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw Error("Название должно содержать от 1 до 80 символов.");
  if (note.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(note)) throw Error("Заметка должна быть обычным текстом длиной до 1000 символов.");
  const config = normalizeRepositoryConfig({ url: raw.url, branch: raw.branch ?? "", identityMode: "default", identityFile: "" });
  if (!config.url) throw Error("Укажите SSH-адрес репозитория.");
  return { name, note, url: config.url, branch: config.branch };
}

export class SourceLibraryStore {
  private readonly file: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(root: string, private readonly current: () => Promise<RepositoryConfig>) {
    this.file = path.join(root, "infra/runtime/source-library.json");
  }
  // Serialize reads and writes so two actions cannot overwrite one another's notes.
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action, action);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  private async persist(value: SourceLibrary) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, this.file);
  }
  private async load(): Promise<SourceLibrary> {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Не удалось прочитать источники. Сохраненные данные не изменены.");
      const config = await this.current(), now = new Date().toISOString();
      const sources: SourceEntry[] = config.url ? [{ id: randomUUID(), ...sourceFields({ ...config, name: config.url.split(/[/:]/).at(-1)?.replace(/\.git$/, "") || "Основной источник", note: "" }), createdAt: now, updatedAt: now }] : [];
      const initial: SourceLibrary = { version: 1, revision: 0, sources };
      await this.persist(initial); return initial;
    }
    try {
      if (Buffer.byteLength(text) > 512 * 1024) throw Error("Too large");
      const raw = JSON.parse(text);
      if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.sources) || raw.sources.length > 100) throw Error("Invalid catalog");
      const ids = new Set<string>(), identities = new Set<string>();
      const sources = raw.sources.map((source: SourceEntry) => {
        const fields = sourceFields(source), identity = JSON.stringify([fields.url, fields.branch]);
        if (!UUID.test(source.id) || ids.has(source.id) || identities.has(identity) || !Number.isFinite(Date.parse(source.createdAt)) || !Number.isFinite(Date.parse(source.updatedAt))) throw Error("Invalid entry");
        ids.add(source.id); identities.add(identity);
        return { id: source.id, ...fields, createdAt: source.createdAt, updatedAt: source.updatedAt };
      });
      return { version: 1, revision: raw.revision, sources };
    } catch { throw Error("Файл источников поврежден. Он сохранен без изменений; запись отключена до восстановления."); }
  }
  async get() { return this.exclusive(() => this.load()); }
  async save(input: unknown, expectedRevision: number) {
    return this.exclusive(async () => {
      const state = await this.load();
      if (expectedRevision !== state.revision) throw Error("Список изменился в другом окне. Перечитайте источники; введенная заметка не сброшена.");
      const raw = input as Record<string, unknown>, fields = sourceFields(input);
      const id = raw.id;
      if (id !== undefined && (typeof id !== "string" || !UUID.test(id))) throw Error("Некорректный источник.");
      const index = state.sources.findIndex((item) => item.id === id);
      if (id && index < 0) throw Error("Источник больше не найден. Перечитайте список.");
      if (state.sources.some((item) => item.id !== id && item.url === fields.url && item.branch === fields.branch)) throw Error("Источник с таким адресом и веткой уже добавлен.");
      if (index < 0 && state.sources.length >= 100) throw Error("В каталоге уже 100 источников.");
      const now = new Date().toISOString();
      const entry: SourceEntry = { id: index >= 0 ? state.sources[index].id : randomUUID(), ...fields, createdAt: index >= 0 ? state.sources[index].createdAt : now, updatedAt: now };
      const sources = [...state.sources]; if (index >= 0) sources[index] = entry; else sources.push(entry);
      const next: SourceLibrary = { version: 1, revision: state.revision + 1, sources };
      await this.persist(next); return next;
    });
  }
}
