"use strict";
const core = require("./configure-lms-ai.cjs");
const { spawn } = require("node:child_process");
const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS"];
const MANAGED_KEYS = [...KEYS, "SUPPORT_EMAIL", "VAPID_SUBJECT"];
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const email = value => typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);

function encodeEnv(value) {
  // Next dotenv-expand recognizes escaped dollar signs even inside quoted values.
  const escaped = value.replace(/\$/g, "\\$");
  const quote = ["'", "`", '"'].find(candidate => !value.includes(candidate) && (candidate !== '"' || !/\\[nr]/.test(value)));
  if (!quote) fail("MAIL_PASSWORD_QUOTES_UNSUPPORTED");
  return quote + escaped + quote;
}

function normalizeMailInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("MAIL_SETTINGS_INVALID");
  const host = typeof input.SMTP_HOST === "string" ? input.SMTP_HOST.trim() : "";
  if (!host || host.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || host.includes("..")) fail("MAIL_HOST_INVALID");
  const port = String(input.SMTP_PORT ?? "").trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) fail("MAIL_PORT_INVALID");
  const secure = String(input.SMTP_SECURE ?? ""); if (!["true", "false"].includes(secure)) fail("MAIL_TLS_INVALID");
  const user = typeof input.SMTP_USER === "string" ? input.SMTP_USER.trim() : "";
  if (!email(user)) fail("MAIL_USER_INVALID");
  const result = { SMTP_HOST: host, SMTP_PORT: String(Number(port)), SMTP_SECURE: secure, SMTP_USER: user };
  if (input.SMTP_PASS !== undefined && input.SMTP_PASS !== "") {
    if (typeof input.SMTP_PASS !== "string" || input.SMTP_PASS.length > 1024 || /[\x00-\x1f\x7f]/.test(input.SMTP_PASS) || !input.SMTP_PASS.trim()) fail("MAIL_PASSWORD_INVALID");
    encodeEnv(input.SMTP_PASS); result.SMTP_PASS = input.SMTP_PASS;
  }
  return result;
}

function normalizeSettings(input, previous = {}, environment) {
  const value = normalizeMailInput(input);
  if (!value.SMTP_PASS && /(?<!\\)\$/.test(environment?.rawEffective.SMTP_PASS || "")) fail("MAIL_EXISTING_PASSWORD_REFERENCE");
  value.SMTP_PASS ??= previous.SMTP_PASS;
  if (!value.SMTP_PASS) fail("MAIL_PASSWORD_REQUIRED");
  // Validate a reused server password without returning it to Core.
  const normalized = normalizeMailInput(value);
  return { ...normalized, SUPPORT_EMAIL: normalized.SMTP_USER, VAPID_SUBJECT: `mailto:${normalized.SMTP_USER}` };
}

function publicState(e, phase, fields, extra = {}) {
  let safe = {};
  try { const value = normalizeMailInput(fields); safe = Object.fromEntries(KEYS.filter(key => key !== "SMTP_PASS").map(key => [key, value[key]])); } catch { /* A partial old configuration is not a configured sender. */ }
  return { clientId: e.c.clientId, jobId: e.c.jobId, releaseId: e.c.releaseId, phase, updatedAt: new Date().toISOString(),
    passwordPresent: Boolean(fields.SMTP_PASS), configured: Boolean(fields.SMTP_PASS && safe.SMTP_USER), smtpVerified: false,
    supportEmail: email(fields.SUPPORT_EMAIL || fields.SMTP_USER) ? fields.SUPPORT_EMAIL || fields.SMTP_USER : "", supportContactReady: false,
    ...safe, envFile: require("node:path").posix.join(e.c.appPath, "releases", e.c.releaseId, "lms/.env.production.local"), ...extra,
    ...(extra.errorCode ? { errorCode: extra.errorCode.replace(/^AI_/, "MAIL_") } : {}) };
}
const profile = { keys: MANAGED_KEYS, normalize: normalizeSettings, state: publicState, encode: encodeEnv,
  defaults: { SMTP_HOST: "smtp.mail.ru", SMTP_PORT: "465", SMTP_SECURE: "true" },
  decode: value => value.replace(/\\\$/g, "$"),
  capability: { file: "app/api/send-email/route.ts", required: [...KEYS, "nodemailer", "createTransport", "sendMail", "process.env.SMTP_USER"] } };

async function mailEnvironment(input, options = {}) { return core.environment(input, { ...options, profile }); }
async function inspectMail(input, options = {}) {
  const e = await mailEnvironment(input, options); await e.health();
  return publicState(e, "checked", e.effective, await require("./support-contact-upgrade.cjs").probeContact(e, options.contactFetch));
}
async function configureMail(input, settings, options = {}) {
  if (!options.contactPatch) return core.configureAi(input, settings, { ...options, profile });
  const contact = require("./support-contact-upgrade.cjs");
  return core.configureAi(input, settings, { ...options, profile,
    prepare: e => contact.prepareContact(e, options.contactPatch, options),
    activate: contact.activateContact, rollback: contact.restoreContact, cleanup: contact.cleanupContact,
    verify: async (e, values, prepared) => {
      const result = await contact.probeContact(e, options.contactFetch);
      if (!result.supportContactReady || result.supportEmail !== values.SMTP_USER) fail("MAIL_CONTACT_HEALTH_FAILED");
      return { ...result, buildPerformed: prepared?.buildPerformed === true };
    }
  });
}

async function testMail(input, recipient, options = {}) {
  if (!email(recipient)) fail("MAIL_RECIPIENT_INVALID");
  const e = await mailEnvironment(input, options); await e.health();
  const settings = normalizeSettings({ ...e.effective, SMTP_PASS: "" }, e.effective, e);
  try {
    const script = `"use strict";const settings=${JSON.stringify(settings)},recipient=${JSON.stringify(recipient)};
const requireApp=require('node:module').createRequire(${JSON.stringify(require("node:path").join(e.app, "package.json"))});
let transport;
(async()=>{try{
transport=requireApp('nodemailer').createTransport({host:settings.SMTP_HOST,port:Number(settings.SMTP_PORT),secure:settings.SMTP_SECURE==='true',requireTLS:settings.SMTP_SECURE!=='true',
auth:{user:settings.SMTP_USER,pass:settings.SMTP_PASS},connectionTimeout:10000,greetingTimeout:5000,socketTimeout:15000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true,
tls:{minVersion:'TLSv1.2'${options.testTls ? ",ca:" + JSON.stringify(options.testTls.ca) + ",servername:" + JSON.stringify(options.testTls.servername) : ""}}});
await transport.verify();
const result=await transport.sendMail({from:{name:'LMS Core',address:settings.SMTP_USER},to:recipient,subject:'Проверка почты LMS Core',text:'Тестовое письмо. Почтовые параметры выбранной LMS приняты SMTP-сервером.',disableFileAccess:true,disableUrlAccess:true});
if(!result.accepted?.some(address=>String(address).toLowerCase()===recipient.toLowerCase())||result.rejected?.length)throw Object.assign(Error('Rejected'),{code:'ERECIPIENT'});
process.stdout.write(JSON.stringify({sent:true}));
}catch(error){const codes={EAUTH:'MAIL_AUTH_FAILED',ETIMEDOUT:'MAIL_TIMEOUT',ECONNECTION:'MAIL_CONNECTION_FAILED',ESOCKET:'MAIL_TLS_OR_CONNECTION_FAILED',ETLS:'MAIL_TLS_FAILED',ERECIPIENT:'MAIL_RECIPIENT_REJECTED'};process.stdout.write(JSON.stringify({errorCode:codes[error.code]||'MAIL_DELIVERY_FAILED'}));}
finally{if(transport)transport.close();settings.SMTP_PASS='';}})();`;
    const result = options.send ? await options.send(script) : await new Promise((resolve, reject) => {
      if (e.account.uid <= 0 || e.account.gid <= 0) fail("MAIL_SERVICE_ACCOUNT_INVALID");
      // runuser resets supplementary groups too; requiring application dependencies must never run as root.
      const child = spawn("/usr/sbin/runuser", ["-u", e.user, "--", process.execPath, "-"], { cwd: e.app, detached: true, env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", overflow = false;
      const stop = () => { if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch { /* The isolated child group may have exited already. */ } };
      const timer = setTimeout(() => { stop(); reject(Object.assign(Error("MAIL_TIMEOUT"), { code: "MAIL_TIMEOUT" })); }, 45000);
      child.stdin.on("error", () => {});
      child.stdout.on("data", chunk => { if (output.length + chunk.length > 4096) { overflow = true; stop(); } else output += chunk; });
      child.stderr.on("data", () => {});
      child.once("error", () => { clearTimeout(timer); reject(Object.assign(Error("MAIL_PROCESS_FAILED"), { code: "MAIL_PROCESS_FAILED" })); });
      child.once("exit", code => {
        clearTimeout(timer);
        try { if (code !== 0 || overflow) fail("MAIL_PROCESS_FAILED"); resolve(JSON.parse(output)); }
        catch { reject(Object.assign(Error("MAIL_PROCESS_FAILED"), { code: "MAIL_PROCESS_FAILED" })); }
      });
      child.stdin.end(script);
    });
    if (result?.sent !== true) fail(/^(?:MAIL)_[A-Z_]{1,60}$/.test(result?.errorCode || "") ? result.errorCode : "MAIL_DELIVERY_FAILED");
    return publicState(e, "test_sent", settings, { smtpVerified: true, testRecipient: recipient, ...await require("./support-contact-upgrade.cjs").probeContact(e, options.contactFetch) });
  } catch (error) {
    return publicState(e, "test_failed", settings, { errorCode: /^MAIL_[A-Z_]{1,60}$/.test(error.code || "") ? error.code : "MAIL_DELIVERY_FAILED", testRecipient: recipient });
  } finally { settings.SMTP_PASS = ""; }
}

module.exports = { normalizeMailInput, normalizeSettings, encodeEnv, email, inspectMail, configureMail, testMail };
