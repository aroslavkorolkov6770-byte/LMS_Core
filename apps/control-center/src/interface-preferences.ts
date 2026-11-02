import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalize, InterfacePreferences } from "../renderer/preferences";

export class InterfacePreferencesStore {
  private queue: Promise<unknown> = Promise.resolve();
  private current: InterfacePreferences = normalize(null);
  private exists = false;
  private warning = "";

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const contents = await readFile(this.file, "utf8");
      if (contents.length > 16384) throw new Error("Settings file is too large");
      const record = JSON.parse(contents);
      if (record?.version !== 1 || !record.preferences || typeof record.preferences !== "object") throw new Error("Invalid settings format");
      this.current = normalize(record.preferences);
      this.exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warning = "Файл настроек не прочитан. Применены стандартные параметры; выберите оформление заново для сохранения.";
        // Keep the damaged original intact until the owner makes an explicit settings change.
        this.exists = true;
      }
    }
  }

  peek(): InterfacePreferences { return { ...this.current }; }

  async flush(): Promise<void> { await this.queue; }

  async read(legacy?: unknown): Promise<{ preferences: InterfacePreferences; warning: string }> {
    if (!this.exists && legacy && typeof legacy === "object") await this.save(legacy);
    return { preferences: this.peek(), warning: this.warning };
  }

  save(input: unknown): Promise<InterfacePreferences> {
    const preferences = normalize(input);
    // Serialize atomic replacements so rapid theme clicks cannot let an older write win.
    const operation = this.queue.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, preferences }, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
      this.current = preferences;
      this.exists = true;
      this.warning = "";
      return this.peek();
    });
    this.queue = operation;
    return operation;
  }
}
