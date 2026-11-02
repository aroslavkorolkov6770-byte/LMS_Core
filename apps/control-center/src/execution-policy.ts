import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RemoteTarget } from "./remote-target";
export class ExecutionPolicy {
  constructor(private readonly root: string) {}
  async mode(): Promise<"local" | "remote"> { try { const value = JSON.parse(await readFile(path.join(this.root, "infra/runtime/execution-policy.json"), "utf8")); return value.version === 1 && value.mode === "remote" ? "remote" : "local"; } catch { return "local"; } }
  async set(mode: unknown) { if (mode !== "local" && mode !== "remote") throw Error("Некорректный режим выполнения."); const file = path.join(this.root, "infra/runtime/execution-policy.json"); await mkdir(path.dirname(file), { recursive: true }); const temporary = file + "." + randomUUID() + ".tmp"; await writeFile(temporary, JSON.stringify({ version: 1, mode }), { flag: "wx", mode: 0o600 }); await rename(temporary, file); return mode; }
  async allowed(target: RemoteTarget) { return ["127.0.0.1", "localhost"].includes(target.host) || await this.mode() === "remote"; }
}
