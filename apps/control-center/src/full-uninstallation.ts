import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NewDeploymentService } from "./new-deployment";
import { Credentials, normalizeRemoteTarget, RemoteTarget, RemoteTargetService } from "./remote-target";
import { UninstallationService, UninstallationState } from "./uninstallation";

export type FullRemovalState = Omit<UninstallationState, "version" | "preserveData"> & {
  version: 2; mode: "full"; preserveData: false; database: string; archiveCompleted: boolean;
  databaseDeleted?: boolean; serviceAccountDeleted?: boolean; certificatesArchived?: boolean; legacy?: boolean;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const phases = ["checked", "running", "uninstalled", "failed", "needs_attention"];
const dependencies = ["complete-lms-removal.cjs", "delete-client-database.cjs", "uninstall-lms.cjs", "publish-lms-ip.cjs", "runtime-process.cjs"];

export class FullUninstallationService {
  private busy = false;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">,
    private readonly deployments: Pick<NewDeploymentService, "get">,
    private readonly archive: Pick<UninstallationService, "get" | "prepare" | "execute" | "refresh" | "accepted">,
    private readonly allowed: (target: RemoteTarget) => Promise<boolean>) {}
  private file(clientId: string) { if (!UUID.test(clientId)) throw Error("Выберите клиента Core."); return path.join(this.root, "infra/runtime/full-uninstallations", clientId + ".json"); }
  private normalize(raw: FullRemovalState): FullRemovalState {
    if (!raw || raw.version !== 2 || raw.mode !== "full" || raw.preserveData !== false || ![raw.clientId, raw.jobId, raw.releaseId, raw.operationId].every(value => UUID.test(value)) || !phases.includes(raw.phase) || !/^\/srv\/lms-core\/clients\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.appPath) || raw.database !== "lms_" + raw.clientId.replaceAll("-", "") || !Number.isInteger(raw.webPort) || raw.webPort < 3000 || raw.webPort > 3099 || ![raw.updatedAt, raw.checkedAt].every(value => Number.isFinite(Date.parse(value))) || typeof raw.archiveCompleted !== "boolean") throw Error("Учет полного удаления не прочитан. Повтор заблокирован.");
    const target = normalizeRemoteTarget(raw.target), backupPath = `/srv/lms-core/backups/${raw.clientId}/${raw.operationId}`;
    if (!target.fingerprint || target.appPath !== raw.appPath || raw.backupPath && raw.backupPath !== backupPath || raw.phase === "uninstalled" && (!raw.databaseDeleted || !raw.serviceAccountDeleted || !raw.certificatesArchived)) throw Error("Полное удаление не подтверждено; данные учета сохранены.");
    return { version: 2, mode: "full", preserveData: false, clientId: raw.clientId, jobId: raw.jobId, releaseId: raw.releaseId, operationId: raw.operationId, target, appPath: raw.appPath, webPort: raw.webPort,
      database: raw.database, phase: raw.phase, updatedAt: raw.updatedAt, checkedAt: raw.checkedAt, archiveCompleted: raw.archiveCompleted,
      ...(raw.backupPath ? { backupPath } : {}), databaseDeleted: raw.databaseDeleted === true, serviceAccountDeleted: raw.serviceAccountDeleted === true, certificatesArchived: raw.certificatesArchived === true,
      ...(raw.legacy ? { legacy: true } : {}), ...(typeof raw.errorCode === "string" && /^[A-Z_]{1,80}$/.test(raw.errorCode) ? { errorCode: raw.errorCode } : {}) };
  }
  async get(clientId: string): Promise<FullRemovalState | null> {
    try {
      const state = this.normalize(JSON.parse(await readFile(this.file(clientId), "utf8")));
      if (state.clientId !== clientId) throw Error("Другой клиент удаления.");
      if (!this.busy && state.phase === "running") { state.phase = "needs_attention"; state.errorCode = "FULL_REMOVAL_RESULT_UNCONFIRMED"; }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const previous = await this.archive.get(clientId);
      if (!previous) return null;
      return this.normalize({ ...previous, version: 2, mode: "full", preserveData: false, database: "lms_" + clientId.replaceAll("-", ""), archiveCompleted: previous.phase === "uninstalled", phase: "needs_attention", legacy: true, errorCode: "FULL_REMOVAL_PREPARATION_REQUIRED" });
    }
  }
  private async save(state: FullRemovalState) {
    const value = this.normalize(state), file = this.file(value.clientId), tmp = file + "." + randomUUID() + ".tmp";
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(tmp, file); return value;
  }
  async accepted(): Promise<boolean> {
    try {
      if (!await this.archive.accepted()) return false;
      const gate = JSON.parse(await readFile(path.join(this.root, "infra/runtime/full-removal-acceptance.json"), "utf8"));
      if (gate.version !== 2 || !gate.accepted || !gate.databaseDeleted || !gate.serviceAccountDeleted || !gate.certificatesArchived || !gate.reinstallReady || !gate.realReprovisionAndAdmins || !gate.otherDatabasePreserved || !gate.backupRestored || !gate.fixtureCleaned) return false;
      for (const file of dependencies) if (gate.dependencies?.[file] !== createHash("sha256").update(await readFile(path.join(this.root, "infra/scripts", file))).digest("hex")) return false;
      return true;
    } catch { return false; }
  }
  private payload(state: FullRemovalState) { return { clientId: state.clientId, jobId: state.jobId, releaseId: state.releaseId, operationId: state.operationId, appPath: state.appPath, webPort: state.webPort, host: state.target.host }; }
  private async script(state: FullRemovalState, execute: boolean) {
    const names = ["removal", "database", "archive", "publication", "vault"];
    let script = "";
    for (let i = 0; i < dependencies.length; i++) script += `const ${names[i]}=(()=>{const module={exports:{}};const exports=module.exports;${await readFile(path.join(this.root, "infra/scripts", dependencies[i]), "utf8")}\nreturn module.exports;})();\n`;
    return script + `removal.${execute ? "completeRemoval" : "inspectFullRemoval"}(${JSON.stringify(this.payload(state))},{database,archive,publication,unseal:vault.openSecrets,archived:${state.archiveCompleted},agreement:${execute}}).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>process.stdout.write(JSON.stringify({errorCode:/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'FULL_REMOVAL_FAILED'})));`;
  }
  private result(state: FullRemovalState, raw: Record<string, any>) {
    if (["clientId", "jobId", "releaseId", "operationId", "appPath"].some(key => raw[key] !== state[key as keyof FullRemovalState]) || raw.mode !== "full" || raw.preserveData !== false) throw Error(`Полное удаление не подтверждено: ${/^[A-Z_]{1,80}$/.test(raw.errorCode || "") ? raw.errorCode : "FULL_REMOVAL_RESULT_INVALID"}. Нажмите проверку результата.`);
    return this.normalize({ ...state, ...Object.fromEntries(["phase", "archiveCompleted", "databaseDeleted", "serviceAccountDeleted", "certificatesArchived", "backupPath", "errorCode"].filter(key => raw[key] !== undefined).map(key => [key, raw[key]])), updatedAt: new Date().toISOString(), legacy: false });
  }
  private async target(clientId: string, input: unknown) {
    const installed = await this.deployments.get(clientId, true), target = normalizeRemoteTarget(input);
    if (!installed || installed.phase !== "succeeded" || ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof RemoteTarget] !== installed.target[key as keyof RemoteTarget]) || !await this.allowed(installed.target)) throw Error("Выберите точную разрешенную SSH-цель управляемой установки.");
    return installed;
  }
  async prepare(clientId: string, input: unknown, auth: Credentials) {
    if (this.busy) throw Error("Удаление уже выполняется."); this.busy = true;
    try {
      const installed = await this.target(clientId, input), previous = await this.get(clientId);
      if (previous?.phase === "uninstalled" && previous.jobId === installed.id) throw Error("Эта LMS и ее БД уже удалены.");
      let archived = await this.archive.get(clientId);
      if (archived && (archived.jobId !== installed.id || archived.releaseId !== installed.releaseId)) archived = null;
      if (archived && ["running", "needs_attention"].includes(archived.phase)) archived = await this.archive.refresh(clientId, installed.target, { ...auth });
      if (archived && ["running", "needs_attention"].includes(archived.phase)) throw Error("Сначала подтвердите результат архивирования; слепой повтор остановки запрещен.");
      if (archived?.phase !== "uninstalled") archived = await this.archive.prepare(clientId, installed.target, { ...auth });
      const now = new Date().toISOString();
      let state = this.normalize({ ...archived, version: 2, mode: "full", preserveData: false, database: "lms_" + clientId.replaceAll("-", ""), archiveCompleted: archived.phase === "uninstalled", phase: "checked", checkedAt: now, updatedAt: now });
      const result = await this.remote.withSession(installed.target, { ...auth }, async session => session.execute("node -", await this.script(state, false), 120000));
      state = this.result(state, JSON.parse(result)); return await this.save(state);
    } finally { this.busy = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
  async execute(clientId: string, operationId: string, input: unknown, auth: Credentials) {
    if (this.busy) throw Error("Удаление уже выполняется."); this.busy = true;
    let state: FullRemovalState | null = null;
    try {
      if (!await this.accepted()) throw Error("Нужна актуальная локальная Linux-проверка полного удаления и повторной установки.");
      const installed = await this.target(clientId, input); state = await this.get(clientId);
      if (!state || state.legacy || state.phase !== "checked" || state.operationId !== operationId || state.jobId !== installed.id || state.releaseId !== installed.releaseId || Date.now() - Date.parse(state.checkedAt) < 0 || Date.now() - Date.parse(state.checkedAt) > 300000) throw Error("Повторите проверку удаления; план изменился или истек.");
      state = await this.save({ ...state, phase: "running" });
      if (!state.archiveCompleted) {
        const result = await this.archive.execute(clientId, operationId, installed.target, { ...auth });
        if (result.phase !== "uninstalled") return await this.save({ ...state, phase: result.phase, errorCode: result.errorCode || "FULL_REMOVAL_ARCHIVE_FAILED" });
        state = await this.save({ ...state, archiveCompleted: true, backupPath: result.backupPath });
      }
      const active = state;
      const raw = await this.remote.withSession(installed.target, { ...auth }, async session => session.execute("node -", await this.script(active, true), 600000));
      return await this.save(this.result(state, JSON.parse(raw)));
    } catch (error) {
      if (state?.phase === "running") await this.save({ ...state, phase: "needs_attention", errorCode: "FULL_REMOVAL_RESULT_UNCONFIRMED" });
      throw error;
    } finally { this.busy = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
  async refresh(clientId: string, input: unknown, auth: Credentials) {
    if (this.busy) throw Error("Дождитесь завершения удаления."); this.busy = true;
    try {
      const state = await this.get(clientId); if (!state) throw Error("Нет задания удаления.");
      await this.target(clientId, input);
      const file = `/srv/lms-core/backups/${clientId}/${state.operationId}/full-removal.json`;
      const script = `const fs=require('node:fs'),path=require('node:path');try{const file=${JSON.stringify(file)};let p=path.dirname(file);while(p!=='/'){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw Error();p=path.dirname(p)}const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||s.size>65536||(s.mode&0o077))throw Error();process.stdout.write(fs.readFileSync(file,'utf8'))}catch{process.stdout.write(JSON.stringify({errorCode:'FULL_REMOVAL_RECEIPT_UNAVAILABLE'}))}`;
      const raw = JSON.parse(await this.remote.withSession(state.target, { ...auth }, session => session.execute("node -", script)));
      if (raw.errorCode === "FULL_REMOVAL_RECEIPT_UNAVAILABLE") {
        const archived = await this.archive.refresh(clientId, state.target, { ...auth });
        return await this.save({ ...state, archiveCompleted: archived.phase === "uninstalled", backupPath: archived.backupPath, phase: "needs_attention", errorCode: "FULL_REMOVAL_PREPARATION_REQUIRED" });
      }
      const value = this.result(state, raw); if (value.phase === "running") value.phase = "needs_attention";
      return await this.save(value);
    } finally { this.busy = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
}
