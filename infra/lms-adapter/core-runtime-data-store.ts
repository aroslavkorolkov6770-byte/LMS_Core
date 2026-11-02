import "server-only";

const protocol = "lms-core-runtime-v1";
type Entry = { key: string; requestedKey: string; found: boolean; revision: number; data: unknown };
type RuntimeOptions = { apiUrl: string; serviceToken: string; fetcher?: typeof fetch };

class CoreRuntimeError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function validKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !/^[a-z0-9][a-z0-9_.@:-]{0,199}$/i.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid Core runtime key");
}

export function createCoreRuntimeStore(options: RuntimeOptions) {
  let base: URL;
  try { base = new URL(options.apiUrl); } catch { throw new Error("Core Runtime API URL is not configured"); }
  const local = ["127.0.0.1", "localhost", "::1"].includes(base.hostname.replace(/^\[|\]$/g, ""));
  if (!(["https:"].includes(base.protocol) || base.protocol === "http:" && local) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Core Runtime requires an HTTPS origin or a loopback HTTP origin without credentials");
  }
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(options.serviceToken)) throw new Error("Core Runtime server token is not configured");
  const fetcher = options.fetcher || fetch;
  const request = async (action: "read" | "write", body: unknown): Promise<Record<string, unknown>> => {
    try {
      const response = await fetcher(new URL(`/api/lms-runtime/v1/${action}`, base), { method: action === "write" ? "PUT" : "POST", redirect: "error", cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${options.serviceToken}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new CoreRuntimeError(response.status, `Core Runtime request failed (${response.status}); no JSON/MySQL fallback was used`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 34 * 1024 * 1024 || !response.body) throw new Error("Invalid runtime response");
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 34 * 1024 * 1024) throw new Error("Runtime response too large");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString("utf8");
      const result = JSON.parse(text);
      if (!result || result.protocol !== protocol) throw new Error("Runtime protocol mismatch");
      return result;
    } catch (error) {
      if (error instanceof CoreRuntimeError) throw error;
      // Do not include URLs, tokens, server bodies or credential-containing payloads.
      throw new CoreRuntimeError(503, "Core Runtime is unavailable or returned an invalid response; no local fallback was used");
    }
  };
  const readEntries = async (keys: string[]): Promise<Map<string, Entry>> => {
    const unique = [...new Set(keys)];
    unique.forEach(validKey);
    if (unique.length > 128) throw new Error("Too many Core runtime keys");
    if (!unique.length) return new Map();
    const response = await request("read", { keys: unique });
    if (!Array.isArray(response.entries) || response.entries.length !== unique.length) throw new CoreRuntimeError(503, "Incomplete Core Runtime response");
    const entries = new Map<string, Entry>();
    for (const value of response.entries) {
      const row = value as Entry;
      if (!row || !unique.includes(row.requestedKey) || entries.has(row.requestedKey) || typeof row.key !== "string" || typeof row.found !== "boolean" ||
          !Number.isSafeInteger(row.revision) || row.revision < 0 || !Object.hasOwn(row, "data")) throw new CoreRuntimeError(503, "Invalid Core Runtime entry");
      entries.set(row.requestedKey, row);
    }
    return entries;
  };
  return {
    async readDataValue<T = unknown>(key: string, fallback: T): Promise<T> {
      const row = (await readEntries([key])).get(key)!;
      return row.found ? structuredClone(row.data) as T : fallback;
    },
    async readDataValues(keys: string[]): Promise<Record<string, unknown>> {
      const entries = await readEntries(keys);
      return Object.fromEntries([...entries].map(([key, row]) => [key, row.found ? structuredClone(row.data) : []]));
    },
    async writeDataValue(key: string, data: unknown): Promise<void> {
      validKey(key);
      const current = (await readEntries([key])).get(key)!;
      const result = await request("write", { key, data, expectedRevision: current.revision });
      if (result.key !== current.key || result.revision !== current.revision + 1) throw new CoreRuntimeError(503, "Core Runtime write was not confirmed; inspect the result before retrying");
      // A write is never automatically retried after an ambiguous network failure or a conflict.
    }
  };
}

const configuredStore = () => createCoreRuntimeStore({ apiUrl: process.env.CORE_RUNTIME_API_URL || "", serviceToken: process.env.CORE_RUNTIME_SERVICE_TOKEN || "" });
export const readDataValue = <T = unknown>(key: string, fallback: T): Promise<T> => configuredStore().readDataValue(key, fallback);
export const readDataValues = (keys: string[]): Promise<Record<string, unknown>> => configuredStore().readDataValues(keys);
export const writeDataValue = (key: string, data: unknown): Promise<void> => configuredStore().writeDataValue(key, data);
