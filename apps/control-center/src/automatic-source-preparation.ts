import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

export class AutomaticSourcePreparation {
  private readonly requests = new Map<string, Promise<void>>();
  constructor(private readonly root: string, private readonly progress: (value: { snapshotId: string; message: string }) => void = () => {}) {}
  prepare(snapshotId: string): Promise<void> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(snapshotId)) return Promise.reject(Error("Выберите полученную Git-версию."));
    const existing = this.requests.get(snapshotId); if (existing) return existing;
    const operation = this.execute(snapshotId).finally(() => this.requests.delete(snapshotId));
    this.requests.set(snapshotId, operation); return operation;
  }
  private async execute(snapshotId: string): Promise<void> {
    let last = "", reading = false, closed = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (reading) return; reading = true;
      try {
        const value = JSON.parse(await readFile(path.join(this.root, "infra/runtime/source-preparation", snapshotId, "progress.json"), "utf8"));
        if (!closed && value.snapshotId === snapshotId && Date.parse(value.at) >= started && typeof value.message === "string" && value.message.length < 250 && value.message !== last) { last = value.message; this.progress({ snapshotId, message: last }); }
      } catch { /* Progress must not determine success; the final acceptance receipt does. */ }
      finally { reading = false; }
    }, 700);
    try {
      const result = await run("node", [path.join(this.root, "infra/scripts/prepare-lms-source.cjs"), snapshotId], { cwd: this.root, windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 128 * 1024 });
      const value = JSON.parse(result.stdout);
      if (!value.accepted || value.snapshotId !== snapshotId) throw Error("SOURCE_ACCEPTANCE_UNCONFIRMED");
    } catch (error) {
      let value: { errorCode?: string; step?: string } = {};
      try { value = JSON.parse((error as { stderr?: string }).stderr || "{}"); } catch {}
      const stages: Record<string, string> = { contracts: "совместимость storage/auth", dependencies: "зависимости npm", build: "сборка или TypeScript", runtime: "локальный запуск, вход или PostgreSQL" };
      const code = /^SOURCE_[A-Z_]{1,80}$/.test(value.errorCode || "") ? value.errorCode : "SOURCE_PREPARATION_FAILED";
      throw Error(`Подготовка выбранного Git-кода остановлена: ${stages[value.step || ""] || "локальная проверка"}. ${code === "SOURCE_CONTRACT_UNSUPPORTED" ? "Эта структура LMS пока не поддерживается адаптером Core." : "Смотрите локальный отчет подготовки исходника."} Код: ${code}. Сервер не изменен; предыдущая Git-версия не подставлялась.`);
    } finally { closed = true; clearInterval(timer); }
  }
}
