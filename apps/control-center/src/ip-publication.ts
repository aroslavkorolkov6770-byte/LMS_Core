import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NewDeploymentService } from "./new-deployment";
import { Credentials, normalizeRemoteTarget, RemoteTarget, RemoteTargetService } from "./remote-target";

export type IpPublicationState = { clientId: string; jobId: string; releaseId: string; host: string; phase: string; updatedAt: string; url?: string; errorCode?: string; failedStep?: string; httpOnlyTest?: boolean;
  protocol?: "http" | "https"; expiresAt?: string; autoRenew?: boolean; renewalState?: "scheduled" | "ok" | "failed" | "inactive" | "unconfirmed"; rollback?: boolean; stagingCheck?: "passed" | "unavailable" };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const phases = ["publishing", "succeeded", "failed", "needs_attention"];

export class IpPublicationService {
  private busy = false;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">,
    private readonly deployments: Pick<NewDeploymentService, "get">, private readonly targetAllowed: (target: RemoteTarget) => Promise<boolean>) {}
  private file(clientId: string) {
    if (!UUID.test(clientId)) throw Error("Выберите клиента Core.");
    return path.join(this.root, "infra/runtime/ip-publications", clientId + ".json");
  }
  private normalize(raw: IpPublicationState): IpPublicationState {
    if (!raw || !UUID.test(raw.clientId) || !UUID.test(raw.jobId) || !UUID.test(raw.releaseId) || isIP(raw.host) !== 4 || !phases.includes(raw.phase) || !Number.isFinite(Date.parse(raw.updatedAt))) throw Error("Некорректный результат публикации.");
    const protocol = raw.protocol === "https" ? "https" : "http";
    let phase = raw.phase, errorCode = raw.errorCode;
    if (protocol === "https" && phase === "succeeded") {
      if (!raw.expiresAt || !Number.isFinite(Date.parse(raw.expiresAt))) throw Error("Срок HTTPS-сертификата не подтвержден.");
      if (Date.parse(raw.expiresAt) <= Date.now()) { phase = "needs_attention"; errorCode = "TLS_CERTIFICATE_EXPIRED"; }
      else if (raw.autoRenew !== true || !["scheduled", "ok", "failed"].includes(raw.renewalState || "")) { phase = "needs_attention"; errorCode = "TLS_RENEWAL_NOT_ACTIVE"; }
      else if (raw.renewalState === "failed") { phase = "needs_attention"; errorCode = "TLS_RENEWAL_FAILED"; }
    }
    return { clientId: raw.clientId, jobId: raw.jobId, releaseId: raw.releaseId, host: raw.host, phase, updatedAt: raw.updatedAt, protocol,
      ...((phase === "succeeded" || protocol === "https") ? { url: `${protocol}://${raw.host}`, httpOnlyTest: protocol === "http" } : {}),
      ...(protocol === "https" ? { autoRenew: raw.autoRenew === true, renewalState: ["scheduled", "ok", "failed", "inactive", "unconfirmed"].includes(raw.renewalState || "") ? raw.renewalState : "unconfirmed",
        ...(typeof raw.expiresAt === "string" && Number.isFinite(Date.parse(raw.expiresAt)) ? { expiresAt: new Date(raw.expiresAt).toISOString() } : {}) } : {}),
      ...(typeof raw.rollback === "boolean" ? { rollback: raw.rollback } : {}),
      ...(["passed", "unavailable"].includes(raw.stagingCheck || "") ? { stagingCheck: raw.stagingCheck } : {}),
      ...(typeof errorCode === "string" && /^[A-Z_]{1,80}$/.test(errorCode) ? { errorCode } : {}),
      ...(typeof raw.failedStep === "string" && /^[a-z_]{1,80}$/.test(raw.failedStep) ? { failedStep: raw.failedStep } : {}) };
  }
  async get(clientId: string) {
    try {
      const state = this.normalize(JSON.parse(await readFile(this.file(clientId), "utf8")));
      if (state.clientId !== clientId) return null;
      if (!this.busy && state.phase === "publishing") state.phase = "needs_attention";
      return state;
    } catch { return null; }
  }
  private async save(state: IpPublicationState) {
    const file = this.file(state.clientId); await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(this.normalize(state)), { flag: "wx", mode: 0o600 }); await rename(temporary, file);
  }
  async execute(clientId: string, targetInput: unknown, auth: Credentials, checkOnly = false, https = false): Promise<IpPublicationState> {
    if (this.busy) throw Error("Публикация уже выполняется. Не запускайте повторно.");
    this.busy = true;
    let state: IpPublicationState | undefined;
    try {
      if (typeof checkOnly !== "boolean" || typeof https !== "boolean" || checkOnly && https) throw Error("Некорректная команда публикации.");
      const saved = await this.deployments.get(clientId), target = normalizeRemoteTarget(targetInput);
      if (!saved || saved.phase !== "succeeded" || saved.clientId !== clientId || isIP(target.host) !== 4 || !target.fingerprint ||
        ["host", "port", "username", "basePath", "fingerprint"].some((key) => target[key as keyof RemoteTarget] !== saved.target[key as keyof RemoteTarget])) throw Error("Выберите точную SSH-цель успешно установленной LMS с IPv4-адресом.");
      if (!await this.targetAllowed(saved.target)) throw Error("Внешние изменения заблокированы локальным режимом.");
      const payload = { clientId, jobId: saved.id, releaseId: saved.releaseId, host: saved.target.host, appPath: saved.target.appPath, webPort: saved.webPort };
      const worker = await readFile(path.join(this.root, "infra/scripts/publish-lms-ip.cjs"), "utf8");
      const module = require(path.join(this.root, "infra/scripts/publish-lms-ip.cjs")) as { validatePublication: (value: unknown) => unknown };
      module.validatePublication(payload);
      if (!checkOnly) {
        const previous = await this.get(clientId);
        if (previous?.jobId === saved.id && previous.host === saved.target.host && ["publishing", "needs_attention"].includes(previous.phase) && (!previous.errorCode || previous.errorCode === "PUBLICATION_RESULT_UNCONFIRMED")) throw Error("Предыдущая публикация могла продолжиться. Сначала нажмите «Проверить IP-доступ».");
        state = { clientId, jobId: saved.id, releaseId: saved.releaseId, host: saved.target.host, phase: "publishing", updatedAt: new Date().toISOString(), ...(https ? { protocol: "https" } : {}) };
        await this.save(state);
      }
      const script = checkOnly ? `${worker}\ncheckIpPublication(${JSON.stringify(payload)}).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>process.stdout.write(JSON.stringify({errorCode:'PUBLICATION_CHECK_FAILED'})));` :
        `${worker}\n${https ? "enableIpHttps" : "publishIp"}(${JSON.stringify({ ...payload, ...(https ? { acmeAgreement: true } : {}) })}).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>process.stdout.write(JSON.stringify({errorCode:/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'IP_PUBLICATION_FAILED'})));`;
      const output = await this.remote.withSession(saved.target, auth, (session) => session.execute("node -", script, checkOnly ? 90000 : https ? 2400000 : 600000));
      let result = JSON.parse(output);
      if (!checkOnly && !result.phase && ["LINUX_ROOT_REQUIRED", "PUBLICATION_INPUT_INVALID", "PUBLICATION_PATH_UNSAFE", "PUBLICATION_FILE_UNSAFE", "PUBLICATION_OWNER_MISMATCH", "PUBLICATION_HEALTH_FAILED"].includes(result.errorCode)) {
        result = { ...state, phase: "failed", errorCode: result.errorCode, updatedAt: new Date().toISOString() };
      }
      if (!result.phase) throw Error(`Публичный доступ не подтверждён: ${/^[A-Z_]{1,80}$/.test(result.errorCode || "") ? result.errorCode : "PUBLICATION_RESULT_INVALID"}. Существующая LMS не переустанавливалась.`);
      state = this.normalize(result);
      if (state.clientId !== clientId || state.jobId !== saved.id || state.releaseId !== saved.releaseId || state.host !== saved.target.host) throw Error("Результат публикации относится к другому клиенту.");
      await this.save(state); return state;
    } catch (error) {
      if (state?.phase === "publishing") { state.phase = "needs_attention"; state.errorCode = "PUBLICATION_RESULT_UNCONFIRMED"; state.updatedAt = new Date().toISOString(); await this.save(state); }
      throw error;
    } finally { this.busy = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
}
