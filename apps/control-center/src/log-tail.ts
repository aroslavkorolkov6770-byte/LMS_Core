import { open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";

const MAX_TAIL_BYTES = 256 * 1024;

export function decodeLogBytes(buffer: Buffer, clippedStart: boolean): string {
  let offset = 0;
  if (clippedStart) {
    // A byte-limited tail may begin inside a multi-byte UTF-8 character.
    while (offset < Math.min(3, buffer.length) && (buffer[offset] & 0xc0) === 0x80) offset++;
  }
  // A writer may not have finished the final character yet; show it on the next read, not as replacement text.
  return new TextDecoder("utf-8").decode(buffer.subarray(offset), { stream: true });
}

function logIdentity(stats: BigIntStats): string {
  // File identity and nanosecond timestamps also detect rotation and same-size rewrites.
  return [stats.dev, stats.ino, stats.birthtimeNs, stats.size, stats.mtimeNs, stats.ctimeNs, stats.mode, stats.nlink].join(":");
}

export class LogTailReader {
  private readonly cache = new Map<string, { identity: string; text: string }>();

  constructor(private readonly maximumEntries = 4, private readonly openLog: typeof open = open) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 16) throw Error("Некорректный размер кэша журнала.");
  }

  async read(filePath: string, maximumBytes = MAX_TAIL_BYTES, fresh = false): Promise<string> {
    if (!filePath) return "";
    if (typeof filePath !== "string" || !Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_TAIL_BYTES) throw new Error("Некорректные параметры чтения журнала.");
    const key = JSON.stringify([path.resolve(filePath), maximumBytes]);
    if (fresh) this.cache.delete(key);
    let file;
    try { file = await this.openLog(filePath, "r"); }
    catch (error) {
      this.cache.delete(key);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw new Error("Не удалось открыть журнал. Проверьте доступ к файлу.");
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const stats = await file.stat({ bigint: true });
        if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Not a readable regular log file");
        const identity = logIdentity(stats), cached = this.cache.get(key);
        if (cached?.identity === identity) {
          this.cache.delete(key); this.cache.set(key, cached);
          return cached.text;
        }
        this.cache.delete(key);
        const size = Number(stats.size), length = Math.min(size, maximumBytes);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, size - length);
        if (bytesRead === 0 && size > 0 && attempt === 0) continue;
        const clipped = size > length;
        const text = `${clipped && bytesRead ? "Показана последняя часть журнала.\n\n" : ""}${decodeLogBytes(buffer.subarray(0, bytesRead), clipped)}`;
        // A file that changed during reading is shown, but never reused as an unchanged snapshot.
        if (identity === logIdentity(await file.stat({ bigint: true }))) {
          this.cache.set(key, { identity, text });
          while (this.cache.size > this.maximumEntries) this.cache.delete(this.cache.keys().next().value!);
        }
        return text;
      }
      return "";
    } catch {
      this.cache.delete(key);
      throw new Error("Не удалось прочитать журнал. Повторите обновление после завершения записи файла.");
    } finally {
      try { await file.close(); }
      catch { this.cache.delete(key); throw new Error("Не удалось завершить чтение журнала."); }
    }
  }
}

export async function readLogTail(filePath: string, maximumBytes = MAX_TAIL_BYTES): Promise<string> {
  return new LogTailReader(1).read(filePath, maximumBytes);
}
