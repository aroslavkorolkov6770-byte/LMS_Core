import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NewDeploymentService } from "./new-deployment";
import { Credentials, normalizeRemoteTarget, RemoteTarget, RemoteTargetService } from "./remote-target";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const IDS = ["AI_PROJECT_ID", "AI_PROMPT_ID", "AI_VECTOR_STORE_ID"] as const;
export type AiSettingsInput = { AI_API_KEY?: string; AI_PROJECT_ID: string; AI_PROMPT_ID: string; AI_VECTOR_STORE_ID: string };
export type AiConfigurationState = { clientId: string; jobId: string; releaseId: string; host: string; phase: "applying" | "applied" | "checked" | "failed" | "needs_attention"; updatedAt: string;
  apiKeyPresent: boolean; configured: boolean; providerVerified: false; AI_PROJECT_ID: string; AI_PROMPT_ID: string; AI_VECTOR_STORE_ID: string; envFile?: string; errorCode?: string; rollbackRestored?: boolean; indexId?: string; indexReused?: boolean; indexExpiryDays?: number; indexExpiresAt?: number; indexExpiryDiagnostic?: { anchor: string; policyKeys: string; timestampType: string; timestampZero: boolean }; provisionMode?: "core_vector_store" };

export function normalizeAiInput(raw: unknown): AiSettingsInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Заполните параметры Alice AI.");
  const value = raw as Record<string, unknown>;
  const result = {} as AiSettingsInput;
  for (const key of IDS) {
    if (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value[key].trim())) throw Error("Укажите ID каталога, созданного агента/Prompt и Vector Store из примера подключения Yandex AI Studio.");
    if (/^\d+$/.test(value[key].trim())) throw Error("Номер клиента вроде 0001 не является ID ресурса Yandex AI Studio. Сначала создайте агента/Prompt и Vector Store, затем скопируйте настоящие ID и ID каталога.");
    result[key] = value[key].trim();
  }
  if (value.AI_API_KEY !== undefined && value.AI_API_KEY !== "") {
    if (typeof value.AI_API_KEY !== "string" || !/^[A-Za-z0-9_./~+%=:!-]{1,8192}$/.test(value.AI_API_KEY.trim())) throw Error("Вставьте только значение API-токена, без Bearer, переносов строк, пробелов и кавычек.");
    result.AI_API_KEY = value.AI_API_KEY.trim();
  }
  return result;
}

export function normalizeAiProvisionInput(raw: unknown): AiSettingsInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Заполните каталог и Prompt клиента.");
  // The vector-store identifier is produced by Core, never taken from a stale/manual field.
  return normalizeAiInput({ ...raw, AI_VECTOR_STORE_ID: "core-auto-pending" });
}

export class AiConfigurationService {
  private busy = false;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">,
    private readonly deployments: Pick<NewDeploymentService, "get">, private readonly targetAllowed: (target: RemoteTarget) => Promise<boolean>) {}
  private file(clientId: string): string {
    if (!UUID.test(clientId)) throw Error("Выберите клиента Core.");
    return path.join(this.root, "infra/runtime/ai-configuration", clientId + ".json");
  }
  private normalize(raw: Record<string, unknown>): AiConfigurationState {
    if (!["clientId", "jobId", "releaseId"].every(key => UUID.test(String(raw[key]))) || !["applying", "applied", "checked", "failed", "needs_attention"].includes(String(raw.phase)) || !/^[a-z0-9][a-z0-9.-]*$/i.test(String(raw.host)) || !Number.isFinite(Date.parse(String(raw.updatedAt)))) throw Error("AI_RESULT_INVALID");
    const ids = Object.fromEntries(IDS.map(key => [key, typeof raw[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(raw[key]) ? raw[key] : ""])) as Pick<AiConfigurationState, typeof IDS[number]>;
    const expiry = raw.indexExpiryDiagnostic as AiConfigurationState["indexExpiryDiagnostic"];
    return { clientId: String(raw.clientId), jobId: String(raw.jobId), releaseId: String(raw.releaseId), host: String(raw.host), phase: raw.phase as AiConfigurationState["phase"], updatedAt: String(raw.updatedAt),
      apiKeyPresent: raw.apiKeyPresent === true, configured: raw.configured === true && raw.apiKeyPresent === true && IDS.every(key => Boolean(ids[key]) && !/^\d+$/.test(ids[key])), providerVerified: false, ...ids,
      ...(typeof raw.envFile === "string" && /^\/[a-z0-9_./-]+$/i.test(raw.envFile) && !raw.envFile.includes("..") ? { envFile: raw.envFile } : {}),
      ...(typeof raw.errorCode === "string" && /^[A-Z_]{1,80}$/.test(raw.errorCode) ? { errorCode: raw.errorCode } : {}),
      ...(typeof raw.indexId === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{1,255}$/.test(raw.indexId) ? { indexId: raw.indexId, indexReused: raw.indexReused === true } : {}),
      ...(raw.provisionMode === "core_vector_store" ? { provisionMode: "core_vector_store" as const } : {}),
      ...(Number.isSafeInteger(raw.indexExpiryDays) && Number(raw.indexExpiryDays) >= 0 ? { indexExpiryDays: Number(raw.indexExpiryDays) } : {}),
      ...(Number.isSafeInteger(raw.indexExpiresAt) && Number(raw.indexExpiresAt) >= 0 ? { indexExpiresAt: Number(raw.indexExpiresAt) } : {}),
      ...(expiry && ["absent", "empty", "last_active_at", "other"].includes(expiry.anchor) && typeof expiry.policyKeys === "string" && /^[a-z_,]{0,160}$/.test(expiry.policyKeys) && ["absent", "number", "string", "object", "boolean", "undefined"].includes(expiry.timestampType) ? { indexExpiryDiagnostic: { anchor: expiry.anchor, policyKeys: expiry.policyKeys, timestampType: expiry.timestampType, timestampZero: expiry.timestampZero === true } } : {}),
      ...(typeof raw.rollbackRestored === "boolean" ? { rollbackRestored: raw.rollbackRestored } : {}) };
  }
  async get(clientId: string): Promise<AiConfigurationState | null> {
    const file = this.file(clientId);
    try { return this.normalize(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw Error("Не удалось прочитать безопасный результат настройки ИИ."); }
  }
  private async save(state: AiConfigurationState): Promise<void> {
    const file = this.file(state.clientId); await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(this.normalize(state as unknown as Record<string, unknown>)), { flag: "wx", mode: 0o600 }); await rename(temporary, file);
  }
  async execute(clientId: string, targetInput: unknown, auth: Credentials, input: unknown, checkOnly: boolean, provision = false): Promise<AiConfigurationState> {
    if (this.busy) throw Error("Дождитесь завершения текущей настройки ИИ.");
    this.busy = true;
    let settings: AiSettingsInput | undefined, state: AiConfigurationState | undefined;
    try {
      const saved = await this.deployments.get(clientId), target = normalizeRemoteTarget(targetInput);
      if (!saved || saved.phase !== "succeeded" || saved.clientId !== clientId || !target.fingerprint || ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof RemoteTarget] !== saved.target[key as keyof RemoteTarget])) throw Error("Выберите точную SSH-цель успешно установленной LMS.");
      if (!await this.targetAllowed(saved.target)) throw Error("Внешняя настройка заблокирована локальным режимом Core.");
      if (provision && checkOnly) throw Error("Выберите одну команду ИИ.");
      if (!checkOnly) settings = provision ? normalizeAiProvisionInput(input) : normalizeAiInput(input);
      const payload = { clientId, jobId: saved.id, releaseId: saved.releaseId, appPath: saved.target.appPath, webPort: saved.webPort, ...(!checkOnly ? { operationId: randomUUID() } : {}) };
      const workerFile = path.join(this.root, "infra/scripts/configure-lms-ai.cjs");
      const contract = require(workerFile) as { validateTarget: (value: unknown) => unknown };
      contract.validateTarget(payload);
      if (!checkOnly) {
        state = { clientId, jobId: saved.id, releaseId: saved.releaseId, host: saved.target.host, phase: "applying", updatedAt: new Date().toISOString(), apiKeyPresent: false, configured: false, providerVerified: false, AI_PROJECT_ID: "", AI_PROMPT_ID: "", AI_VECTOR_STORE_ID: "" };
        await this.save(state);
      }
      const worker = await readFile(workerFile, "utf8");
      const provisionWorker = provision ? await readFile(path.join(this.root, "infra/scripts/provision-lms-ai.cjs"), "utf8") : "";
      const command = provision ? `const provision=(()=>{const module={exports:{}};const exports=module.exports;${provisionWorker}\nreturn module.exports;})();\nprovision.provisionAi(${JSON.stringify(payload)},${JSON.stringify(settings)},{ai:{configureAi,normalizeSettings}})` : checkOnly ? `inspectAi(${JSON.stringify(payload)})` : `configureAi(${JSON.stringify(payload)},${JSON.stringify(settings)})`;
      const script = worker + "\n" + command + ".then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>process.stdout.write(JSON.stringify({errorCode:/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'AI_CONFIGURATION_FAILED'})));";
      const output = await this.remote.withSession(saved.target, auth, session => session.execute("node -", script, checkOnly ? 45000 : provision ? 360000 : 240000));
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(output); } catch { throw Error("AI_RESULT_INVALID"); }
      if (!raw.phase) throw Error(typeof raw.errorCode === "string" && /^[A-Z_]{1,80}$/.test(raw.errorCode) ? raw.errorCode : "AI_RESULT_INVALID");
      const result = this.normalize({ ...raw, host: saved.target.host });
      if (result.clientId !== clientId || result.jobId !== saved.id || result.releaseId !== saved.releaseId) throw Error("AI_OWNER_MISMATCH");
      await this.save(result); return result;
    } catch (error) {
      if (state) { state.phase = "needs_attention"; state.errorCode = "AI_RESULT_UNCONFIRMED"; state.updatedAt = new Date().toISOString(); await this.save(state); }
      const safe = new Set(["AI_TOKEN_REQUIRED", "AI_TOKEN_INVALID", "AI_IDS_REQUIRED", "AI_IDS_INVALID", "AI_IDS_PLACEHOLDER", "AI_SOURCE_UNSUPPORTED", "AI_CONFIGURATION_BUSY", "AI_ENV_OCCUPIED", "AI_ENV_LINK_UNSAFE", "AI_ENV_FORMAT_UNSUPPORTED", "AI_LMS_HEALTH_FAILED", "AI_OWNER_MISMATCH", "AI_RELEASE_MISMATCH", "AI_RESULT_INVALID"]);
      const code = error instanceof Error && safe.has(error.message) ? error.message : "AI_CONFIGURATION_UNCONFIRMED";
      throw Error(`Настройка ИИ не подтверждена (${code}). Проверьте выбранную LMS, SSH-доступ и результат перед повтором. Токен не выводится в журнал.`);
    } finally {
      this.busy = false;
      if (settings) settings.AI_API_KEY = "";
      if (input && typeof input === "object") delete (input as Record<string, unknown>).AI_API_KEY;
      if (auth) { delete auth.password; delete auth.passphrase; }
    }
  }
}
