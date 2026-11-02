import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Credentials, normalizeRemoteTarget, RemoteTarget, RemoteTargetService } from "./remote-target";
import { NewDeploymentService } from "./new-deployment";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const phases = ["checked", "running", "uninstalled", "failed", "needs_attention"];
export type UninstallationState = { version: 1; operationId: string; clientId: string; jobId: string; releaseId: string; target: RemoteTarget; appPath: string; webPort: number;
  phase: string; checkedAt: string; updatedAt: string; backupPath?: string; errorCode?: string; rollbackRestored?: boolean; preserveData: true };
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export class UninstallationService {
  private busy = false;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">,
    private readonly deployments: Pick<NewDeploymentService, "get">, private readonly allowed: (target: RemoteTarget) => Promise<boolean>) {}
  private file(clientId: string): string {
    if (!UUID.test(clientId)) throw Error("Выберите сохраненного клиента Core.");
    return path.join(this.root, "infra/runtime/uninstallations", `${clientId}.json`);
  }
  private normalize(value: UninstallationState): UninstallationState {
    if (!value || value.version !== 1 || ![value.clientId, value.jobId, value.releaseId, value.operationId].every(id => UUID.test(id)) ||
      !/^\/srv\/lms-core\/clients\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.appPath) || !phases.includes(value.phase) || value.preserveData !== true ||
      !Number.isInteger(value.webPort) || value.webPort < 3000 || value.webPort > 3099 || ![value.checkedAt, value.updatedAt].every(date => typeof date === "string" && Number.isFinite(Date.parse(date)))) throw Error("Некорректная запись удаления LMS.");
    const target = normalizeRemoteTarget(value.target);
    if (!target.fingerprint || target.appPath !== value.appPath) throw Error("Цель удаления LMS не подтверждена.");
    const backupPath = `/srv/lms-core/backups/${value.clientId}/${value.operationId}`;
    if (value.backupPath !== undefined && value.backupPath !== backupPath) throw Error("Путь резервной копии не совпал.");
    return { version: 1, operationId: value.operationId, clientId: value.clientId, jobId: value.jobId, releaseId: value.releaseId, target, appPath: value.appPath, webPort: value.webPort,
      phase: value.phase, checkedAt: value.checkedAt, updatedAt: value.updatedAt, preserveData: true,
      ...(value.backupPath ? { backupPath } : {}), ...(typeof value.errorCode === "string" && /^[A-Z_]{1,80}$/.test(value.errorCode) ? { errorCode: value.errorCode } : {}),
      ...(typeof value.rollbackRestored === "boolean" ? { rollbackRestored: value.rollbackRestored } : {}) };
  }
  async accepted(): Promise<boolean> {
    try {
      const receipt = JSON.parse(await readFile(path.join(this.root, "infra/runtime/uninstall-acceptance.json"), "utf8"));
      if (receipt.version !== 1 || receipt.accepted !== true || !receipt.realSystemd || !receipt.realDatabaseDumpAndRestore || !receipt.publicNginxRemoval || !receipt.fixtureCleaned) return false;
      for (const file of ["uninstall-lms.cjs", "publish-lms-ip.cjs", "runtime-process.cjs"]) if (receipt.dependencies?.[file] !== hash(await readFile(path.join(this.root, "infra/scripts", file)))) return false;
      return true;
    } catch { return false; }
  }
  async get(clientId: string): Promise<UninstallationState | null> {
    try {
      const state = this.normalize(JSON.parse(await readFile(this.file(clientId), "utf8")));
      if (state.clientId !== clientId) throw Error("Другой клиент удаления.");
      if (!this.busy && state.phase === "running") { state.phase = "needs_attention"; state.errorCode = "REMOVAL_RESULT_UNCONFIRMED"; }
      return state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw Error("Не удалось прочитать учет удаления LMS. Не запускайте удаление повторно."); }
  }
  private async save(value: UninstallationState) {
    const state = this.normalize(value), file = this.file(state.clientId), temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 }); await rename(temporary, file); return state;
  }
  private async target(clientId: string, input: unknown) {
    const saved = await this.deployments.get(clientId), target = normalizeRemoteTarget(input);
    if (!saved || saved.phase !== "succeeded" || !saved.target.appPath || !target.fingerprint ||
      ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof RemoteTarget] !== saved.target[key as keyof RemoteTarget])) throw Error("Выберите точный сервер успешно установленной управляемой LMS.");
    if (!await this.allowed(saved.target)) throw Error("Внешние операции заблокированы локальным режимом.");
    return saved;
  }
  private payload(state: UninstallationState) { return { clientId: state.clientId, jobId: state.jobId, releaseId: state.releaseId, operationId: state.operationId, appPath: state.appPath, webPort: state.webPort, host: state.target.host }; }
  private async script(state: UninstallationState, execute: boolean) {
    const wrap = async (file: string, name: string) => `const ${name}=(()=>{const module={exports:{}};const exports=module.exports;\n${await readFile(path.join(this.root, "infra/scripts", file), "utf8")}\nreturn module.exports;})();\n`;
    return await wrap("publish-lms-ip.cjs", "publication") + await wrap("runtime-process.cjs", "vault") + await wrap("uninstall-lms.cjs", "removal") +
      `removal.${execute ? "uninstallLms" : "inspectRemoval"}(${JSON.stringify(this.payload(state))},{publication,unseal:vault.openSecrets,agreement:${execute}}).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>process.stdout.write(JSON.stringify({errorCode:/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'REMOVAL_CHECK_FAILED'})));`;
  }
  private result(state: UninstallationState, raw: Record<string, unknown>): UninstallationState {
    if (["clientId", "jobId", "releaseId", "operationId", "appPath"].some(key => raw[key] !== state[key as keyof UninstallationState]) || !phases.includes(String(raw.phase)) || raw.preserveData !== true) throw Error(`Результат удаления не подтвержден${typeof raw.errorCode === "string" && /^[A-Z_]{1,80}$/.test(raw.errorCode) ? ": " + raw.errorCode : ""}.`);
    return this.normalize({ ...state, phase: String(raw.phase), updatedAt: new Date().toISOString(),
      ...(typeof raw.backupPath === "string" ? { backupPath: raw.backupPath } : {}), errorCode: typeof raw.errorCode === "string" ? raw.errorCode : undefined,
      rollbackRestored: typeof raw.rollbackRestored === "boolean" ? raw.rollbackRestored : undefined });
  }
  async prepare(clientId: string, input: unknown, auth: Credentials) {
    if (this.busy) throw Error("Проверка/удаление уже выполняется."); this.busy = true;
    try {
      const previous = await this.get(clientId), installed = await this.target(clientId, input);
      if (previous && (["running", "needs_attention"].includes(previous.phase) || previous.phase === "uninstalled" && previous.jobId === installed.id)) throw Error("Сначала проверьте результат прежнего удаления. Повторное слепое удаление запрещено.");
      const now = new Date().toISOString();
      const state: UninstallationState = { version: 1, clientId, jobId: installed.id, releaseId: installed.releaseId, operationId: randomUUID(), target: installed.target,
        appPath: installed.target.appPath!, webPort: installed.webPort, phase: "checked", checkedAt: now, updatedAt: now, preserveData: true };
      const script = await this.script(state, false);
      const output = await this.remote.withSession(installed.target, auth, session => session.execute("node -", script));
      return await this.save(this.result(state, JSON.parse(output)));
    } finally { this.busy = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
  async execute(clientId: string, operationId: string, input: unknown, auth: Credentials) {
    if (this.busy) throw Error("Проверка/удаление уже выполняется."); this.busy = true;
    let state: UninstallationState | null = null;
    try {
      if (!await this.accepted()) throw Error("Удаление заблокировано: сначала нужна актуальная локальная Linux-приемка backup/restore.");
      const installed = await this.target(clientId, input); state = await this.get(clientId);
      if (!state || state.phase !== "checked" || state.operationId !== operationId || state.jobId !== installed.id || state.releaseId !== installed.releaseId || JSON.stringify(state.target) !== JSON.stringify(installed.target) ||
        Date.now() - Date.parse(state.checkedAt) < 0 || Date.now() - Date.parse(state.checkedAt) > 5 * 60 * 1000) throw Error("Проверка удаления устарела или установка изменилась. Повторите только проверку удаления.");
      state = await this.save({ ...state, phase: "running", updatedAt: new Date().toISOString() });
      const script = await this.script(state, true);
      const output = await this.remote.withSession(installed.target, auth, session => session.execute("node -", script, 25 * 60 * 1000));
      return await this.save(this.result(state, JSON.parse(output)));
    } catch (error) {
      if (state?.phase === "running") await this.save({ ...state, phase: "needs_attention", errorCode: "REMOVAL_RESULT_UNCONFIRMED", updatedAt: new Date().toISOString() });
      throw error;
    } finally { this.busy = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
  async refresh(clientId: string, input: unknown, auth: Credentials) {
    if (this.busy) throw Error("Дождитесь окончания текущей команды."); this.busy = true;
    try {
      const state = await this.get(clientId), target = normalizeRemoteTarget(input);
      if (!state || ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof RemoteTarget] !== state.target[key as keyof RemoteTarget])) throw Error("Выберите сервер записанного удаления.");
      if (!await this.allowed(state.target)) throw Error("Внешние операции запрещены локальным режимом.");
      const file = `/srv/lms-core/backups/${clientId}/${state.operationId}/receipt.json`;
      const script = `const fs=require('node:fs');const file=${JSON.stringify(file)};try{let p=require('node:path').dirname(file);while(p!=='/'){const d=fs.lstatSync(p);if(!d.isDirectory()||d.isSymbolicLink()||d.uid!==0||(d.mode&0o022))throw Error();p=require('node:path').dirname(p);}const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==0||s.size>16384||(s.mode&0o077))throw Error();process.stdout.write(fs.readFileSync(file,'utf8'));}catch{process.stdout.write(JSON.stringify({errorCode:'REMOVAL_RECEIPT_UNAVAILABLE'}));}`;
      const output = await this.remote.withSession(state.target, auth, session => session.execute("node -", script));
      const result = this.result(state, JSON.parse(output));
      if (result.phase === "running") { result.phase = "needs_attention"; result.errorCode = "REMOVAL_RESULT_UNCONFIRMED"; }
      return await this.save(result);
    } finally { this.busy = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
}
