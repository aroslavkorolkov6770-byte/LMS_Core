import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NewDeploymentService } from "./new-deployment";
import { Credentials, normalizeRemoteTarget, RemoteTarget, RemoteTargetService } from "./remote-target";
import type { ContactPatch } from "./support-contact-adapter";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FIELDS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER"] as const;
export type MailInput = { SMTP_HOST: string; SMTP_PORT: string; SMTP_SECURE: string; SMTP_USER: string; SMTP_PASS?: string };
export type MailAction = "apply" | "check" | "test";
export type MailState = { clientId: string; jobId: string; releaseId: string; host: string; updatedAt: string;
  phase: "applying" | "testing" | "applied" | "checked" | "test_sent" | "test_failed" | "failed" | "needs_attention";
  passwordPresent: boolean; configured: boolean; smtpVerified: boolean; SMTP_HOST: string; SMTP_PORT: string; SMTP_SECURE: string; SMTP_USER: string;
  envFile?: string; errorCode?: string; rollbackRestored?: boolean; testRecipient?: string; supportEmail?: string; supportContactReady?: boolean; buildPerformed?: boolean };

export class MailConfigurationService {
  private busy = false;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">,
    private readonly deployments: Pick<NewDeploymentService, "get">, private readonly targetAllowed: (target: RemoteTarget) => Promise<boolean>,
    private readonly contactPatch?: (snapshotId: string, revision: string) => Promise<ContactPatch>) {}
  private contract(): { normalizeMailInput: (input: unknown) => MailInput; email: (input: unknown) => boolean } {
    return require(path.join(this.root, "infra/scripts/configure-lms-mail.cjs"));
  }
  normalizeInput(input: unknown): MailInput {
    try { return this.contract().normalizeMailInput(input); }
    catch { throw Error("Проверьте SMTP-сервер, порт, режим TLS, адрес отправителя и пароль приложения. Не вводите переносы строк или управляющие символы."); }
  }
  validRecipient(value: unknown): value is string { return this.contract().email(value); }
  private file(clientId: string): string {
    if (!UUID.test(clientId)) throw Error("Выберите клиента Core.");
    return path.join(this.root, "infra/runtime/mail-configuration", clientId + ".json");
  }
  private safe(raw: Record<string, unknown>): MailState {
    if (!["clientId", "jobId", "releaseId"].every(key => UUID.test(String(raw[key]))) ||
        !["applying", "testing", "applied", "checked", "test_sent", "test_failed", "failed", "needs_attention"].includes(String(raw.phase)) ||
        !/^[a-z0-9][a-z0-9.-]*$/i.test(String(raw.host)) || !Number.isFinite(Date.parse(String(raw.updatedAt)))) throw Error("MAIL_RESULT_INVALID");
    let fields: Partial<MailInput> = {};
    try { const input = this.contract().normalizeMailInput(Object.fromEntries(FIELDS.map(key => [key, raw[key]]))); fields = input; } catch { /* An unconfigured server is a valid safe status. */ }
    return { clientId: String(raw.clientId), jobId: String(raw.jobId), releaseId: String(raw.releaseId), host: String(raw.host), updatedAt: String(raw.updatedAt), phase: raw.phase as MailState["phase"],
      passwordPresent: raw.passwordPresent === true, configured: raw.configured === true && raw.passwordPresent === true && FIELDS.every(key => Boolean(fields[key])),
      smtpVerified: raw.phase === "test_sent" && raw.smtpVerified === true, ...Object.fromEntries(FIELDS.map(key => [key, fields[key] || ""])) as Pick<MailState, typeof FIELDS[number]>,
      supportEmail: this.validRecipient(raw.supportEmail) ? raw.supportEmail : "", supportContactReady: raw.supportContactReady === true, buildPerformed: raw.buildPerformed === true,
      ...(typeof raw.envFile === "string" && /^\/[a-z0-9_./-]+$/i.test(raw.envFile) && !raw.envFile.includes("..") ? { envFile: raw.envFile } : {}),
      ...(typeof raw.errorCode === "string" && /^(?:MAIL|AI)_[A-Z_]{1,70}$/.test(raw.errorCode) ? { errorCode: raw.errorCode.replace(/^AI_/, "MAIL_") } : {}),
      ...(typeof raw.rollbackRestored === "boolean" ? { rollbackRestored: raw.rollbackRestored } : {}),
      ...(this.validRecipient(raw.testRecipient) ? { testRecipient: raw.testRecipient } : {}) };
  }
  async get(clientId: string): Promise<MailState | null> {
    try { return this.safe(JSON.parse(await readFile(this.file(clientId), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw Error("Не удалось прочитать безопасный результат настройки почты."); }
  }
  private async save(state: MailState): Promise<void> {
    const file = this.file(state.clientId); await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(this.safe(state as unknown as Record<string, unknown>)), { flag: "wx", mode: 0o600 }); await rename(temporary, file);
  }
  async execute(clientId: string, targetInput: unknown, auth: Credentials, action: MailAction, input?: unknown, recipient?: string): Promise<MailState> {
    if (this.busy) throw Error("Дождитесь завершения текущей настройки почты.");
    this.busy = true;
    let settings: MailInput | undefined, progress: MailState | undefined;
    try {
      if (!["apply", "check", "test"].includes(action)) throw Error("MAIL_ACTION_INVALID");
      const saved = await this.deployments.get(clientId), target = normalizeRemoteTarget(targetInput);
      if (!saved || saved.phase !== "succeeded" || saved.clientId !== clientId || !target.fingerprint ||
          ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof RemoteTarget] !== saved.target[key as keyof RemoteTarget])) throw Error("MAIL_TARGET_MISMATCH");
      if (!await this.targetAllowed(saved.target)) throw Error("MAIL_EXECUTION_BLOCKED");
      if (action === "apply") settings = this.normalizeInput(input);
      if (action === "test" && !this.validRecipient(recipient)) throw Error("MAIL_RECIPIENT_INVALID");
      const payload = { clientId, jobId: saved.id, releaseId: saved.releaseId, appPath: saved.target.appPath, webPort: saved.webPort, ...(action === "apply" ? { operationId: randomUUID() } : {}) };
      require(path.join(this.root, "infra/scripts/configure-lms-ai.cjs")).validateTarget(payload);
      if (action !== "check") {
        progress = { clientId, jobId: saved.id, releaseId: saved.releaseId, host: saved.target.host, phase: action === "apply" ? "applying" : "testing", updatedAt: new Date().toISOString(),
          passwordPresent: false, configured: false, smtpVerified: false, SMTP_HOST: "", SMTP_PORT: "", SMTP_SECURE: "", SMTP_USER: "" };
        await this.save(progress);
      }
      // Only trusted Core workers run as root; the LMS build runs under its service account.
      const common = await readFile(path.join(this.root, "infra/scripts/configure-lms-ai.cjs"), "utf8");
      const worker = await readFile(path.join(this.root, "infra/scripts/configure-lms-mail.cjs"), "utf8");
      const upgrade = await readFile(path.join(this.root, "infra/scripts/support-contact-upgrade.cjs"), "utf8");
      const patch = action === "apply" && this.contactPatch ? await this.contactPatch(saved.snapshotId, saved.revision) : undefined;
      const call = action === "apply" ? `configureMail(${JSON.stringify(payload)},${JSON.stringify(settings)},${JSON.stringify(patch ? { contactPatch: patch } : {})})` : action === "test" ? `testMail(${JSON.stringify(payload)},${JSON.stringify(recipient)})` : `inspectMail(${JSON.stringify(payload)})`;
      const script = `const coreWorker={exports:{}};(function(module){${common}\n})(coreWorker);const contactWorker={exports:{}};(function(module){${upgrade}\n})(contactWorker);const mailWorker={exports:{}};(function(module,require){${worker}\n})(mailWorker,name=>name==='./configure-lms-ai.cjs'?coreWorker.exports:name==='./support-contact-upgrade.cjs'?contactWorker.exports:require(name));\nmailWorker.exports.${call}.then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>process.stdout.write(JSON.stringify({errorCode:/^(?:AI|MAIL)_[A-Z_]{1,70}$/.test(error.code||'')?error.code.replace(/^AI_/,'MAIL_'):'MAIL_CONFIGURATION_FAILED'})));`;
      const output = await this.remote.withSession(saved.target, auth, session => session.execute("node -", script, action === "apply" ? 50 * 60 * 1000 : 70000));
      const raw = JSON.parse(output);
      if (!raw.phase) throw Error(typeof raw.errorCode === "string" && /^MAIL_[A-Z_]{1,70}$/.test(raw.errorCode) ? raw.errorCode : "MAIL_RESULT_INVALID");
      const result = this.safe({ ...raw, host: saved.target.host });
      if (result.clientId !== clientId || result.jobId !== saved.id || result.releaseId !== saved.releaseId) throw Error("MAIL_OWNER_MISMATCH");
      await this.save(result); return result;
    } catch (error) {
      if (progress) { progress.phase = "needs_attention"; progress.errorCode = "MAIL_RESULT_UNCONFIRMED"; progress.updatedAt = new Date().toISOString(); await this.save(progress); }
      const code = error instanceof Error && /^MAIL_[A-Z_]{1,70}$/.test(error.message) ? error.message : "MAIL_CONFIGURATION_UNCONFIRMED";
      throw Error(`Результат почты не подтвержден (${code}). Проверьте выбранную LMS, SSH-доступ и сохраненные настройки; пароль не выводится в журнал.`);
    } finally {
      this.busy = false; if (settings) settings.SMTP_PASS = "";
      if (input && typeof input === "object") delete (input as Record<string, unknown>).SMTP_PASS;
      if (auth) { delete auth.password; delete auth.passphrase; }
    }
  }
}
