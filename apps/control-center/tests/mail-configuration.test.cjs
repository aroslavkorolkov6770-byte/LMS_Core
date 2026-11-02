const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const mail = require("../../../infra/scripts/configure-lms-mail.cjs");
const ai = require("../../../infra/scripts/configure-lms-ai.cjs");
const ui = require("../renderer/mail-configuration.js");
const { MailConfigurationService } = require("../dist/mail-configuration.js");
const values = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "465", SMTP_SECURE: "true", SMTP_USER: "sender@example.invalid", SMTP_PASS: "fixture $password# ' literal\\n" };

test("mail input validates endpoint, TLS, sender, password and a single recipient", () => {
  assert.deepEqual(mail.normalizeMailInput({ ...values, extra: "drop" }), values);
  assert.deepEqual(mail.normalizeSettings({ ...values, SMTP_PASS: "" }, values), { ...values, SUPPORT_EMAIL: values.SMTP_USER, VAPID_SUBJECT: `mailto:${values.SMTP_USER}` });
  for (const patch of [{ SMTP_HOST: "https://smtp.example.invalid" }, { SMTP_HOST: "x\nEVIL=x" }, { SMTP_PORT: "0" }, { SMTP_PORT: "65536" }, { SMTP_SECURE: "maybe" }, { SMTP_USER: "a@a.com,b@b.com" }, { SMTP_PASS: "secret\nOTHER=value" }, { SMTP_PASS: " " }]) {
    assert.throws(() => mail.normalizeMailInput({ ...values, ...patch }));
    assert.ok(ui.validate({ ...values, ...patch }, false));
  }
  assert.equal(ui.validate(values, false), null); assert.equal(mail.email("one@example.invalid"), true); assert.equal(mail.email("one@example.invalid,two@example.invalid"), false);
  assert.throws(() => mail.normalizeSettings({ ...values, SMTP_PASS: "" }), /MAIL_PASSWORD_REQUIRED/);
});

test("mail result formatting never prints an SMTP password or unknown untrusted fields", () => {
  assert.equal(ui.formatResult({ ...values, phase: "applied", passwordPresent: true }).includes(values.SMTP_PASS), false);
  assert.match(ui.formatResult({ phase: "test_sent", passwordPresent: true }), /не гарантия/);
  assert.match(ui.formatResult({ phase: "test_failed", errorCode: "MAIL_AUTH_FAILED" }), /SMTP отклонил вход/);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-mail-worker-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-mail-worker-")); await fs.rm(root, { recursive: true, force: true }); });
  const c = { clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), operationId: crypto.randomUUID(), appPath: "/srv/lms-core/clients/mail-fixture", webPort: 23451 };
  const disk = p => path.join(root, p), base = disk(c.appPath), app = path.join(base, "releases", c.releaseId, "lms"), shared = path.join(base, "shared"), unit = "lms-mail-fixture-web.service";
  await fs.mkdir(path.join(app, "app/api/send-email"), { recursive: true }); await fs.mkdir(path.join(app, "app/lib")); await fs.mkdir(shared); await fs.mkdir(disk("/etc/systemd/system"), { recursive: true });
  await fs.writeFile(path.join(base, ".core-install-owner.json"), JSON.stringify({ ...c, state: "installed", services: [unit] }));
  await fs.writeFile(path.join(shared, "runtime-context.json"), JSON.stringify({ clientId: c.clientId, releaseId: c.releaseId, releaseRoot: `${c.appPath}/releases/${c.releaseId}`, webPort: c.webPort }));
  await fs.symlink(path.dirname(app), path.join(base, "current"), "junction");
  await fs.writeFile(path.join(app, "app/api/send-email/route.ts"), "SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS nodemailer createTransport sendMail process.env.SMTP_USER");
  await fs.writeFile(path.join(app, "app/lib/aliceAi.ts"), "getAliceAiConfig AI_API_KEY AI_PROJECT_ID AI_PROMPT_ID AI_VECTOR_STORE_ID");
  const user = "lms-" + crypto.createHash("sha256").update(c.clientId).digest("hex").slice(0, 20);
  await fs.writeFile(disk(`/etc/systemd/system/${unit}`), `User=${user}\nExecStart=/usr/bin/node ${c.appPath}/releases/${c.releaseId}/backend/runtime-process.cjs ${c.appPath}/shared/runtime-context.json web\n`);
  const calls = [], state = { failRestart: false };
  const options = { fixture: true, root, account: { uid: 0, gid: 0 }, attempts: 1, rollbackAttempts: 1, delayMs: 1,
    run: async (file, args) => { calls.push([file, ...args]); if (args[0] === "restart" && state.failRestart) { state.failRestart = false; throw Error("Fixture restart failed"); } return ""; },
    fetch: async () => ({ ok: true, json: async () => ({ protocol: "lms-core-client-v1", status: "ok", clientId: c.clientId, releaseId: c.releaseId }) }) };
  return { root, c, app, shared, options, calls, state };
}

test("mail and AI share one managed env without erasing each other, including a blank SMTP password", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.app, ".env.production.local"), "UNRELATED=keep\n");
  const first = await mail.configureMail(f.c, values, f.options); assert.equal(first.phase, "applied"); assert.equal(JSON.stringify(first).includes(values.SMTP_PASS), false);
  const aiValues = { AI_API_KEY: "fixture-ai-key", AI_PROJECT_ID: "project", AI_PROMPT_ID: "prompt", AI_VECTOR_STORE_ID: "vector" };
  assert.equal((await ai.configureAi({ ...f.c, operationId: crypto.randomUUID() }, aiValues, f.options)).phase, "applied");
  assert.equal((await mail.configureMail({ ...f.c, operationId: crypto.randomUUID() }, { ...values, SMTP_PASS: "", SMTP_USER: "other@example.invalid" }, f.options)).phase, "applied");
  const contents = await fs.readFile(path.join(f.shared, "ai.env"), "utf8");
  assert.ok(contents.includes("UNRELATED=keep")); assert.ok(contents.includes("AI_API_KEY=fixture-ai-key"));
  const read = await mail.inspectMail(f.c, f.options); assert.equal(read.SMTP_USER, "other@example.invalid"); assert.equal(read.passwordPresent, true); assert.equal(read.smtpVerified, false);
  assert.equal((await ai.inspectAi(f.c, f.options)).apiKeyPresent, true);
  let sentScript = "";
  const sent = await mail.testMail(f.c, "target@example.invalid", { ...f.options, send: async script => { sentScript = script; return { sent: true }; } });
  assert.equal(sent.phase, "test_sent"); assert.equal(sent.smtpVerified, true); assert.ok(sentScript.includes(JSON.stringify(values.SMTP_PASS)));
  assert.equal(JSON.stringify(sent).includes(values.SMTP_PASS), false); assert.ok(sentScript.includes("requireTLS"));
});

test("mail restart failure rolls back the full previous environment, including AI", async t => {
  const f = await fixture(t), old = "AI_API_KEY=unchanged-ai\nKEEP=yes\nSMTP_USER=old@example.invalid\nSMTP_PASS=old-password\n";
  await fs.writeFile(path.join(f.app, ".env.production.local"), old); f.state.failRestart = true;
  const result = await mail.configureMail(f.c, values, f.options); assert.equal(result.phase, "failed"); assert.equal(result.rollbackRestored, true);
  assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), old);
});

test("mail never turns an existing dotenv password reference into a guessed literal", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.app, ".env.production.local"), "SMTP_HOST=smtp.example.invalid\nSMTP_PORT=465\nSMTP_USER=sender@example.invalid\nSMTP_PASS=${OTHER_PASSWORD}\nOTHER_PASSWORD=fixture-old\n");
  const result = await mail.configureMail(f.c, { ...values, SMTP_PASS: "" }, f.options);
  assert.equal(result.phase, "failed"); assert.equal(result.errorCode, "MAIL_EXISTING_PASSWORD_REFERENCE");
  assert.equal(f.calls.some(call => call[1] === "restart"), false);
  assert.equal((await mail.configureMail({ ...f.c, operationId: crypto.randomUUID() }, values, f.options)).phase, "applied");
});

test("mail refuses wrong owners and shares the existing AI operation lock", async t => {
  const f = await fixture(t);
  await assert.rejects(mail.configureMail({ ...f.c, jobId: crypto.randomUUID() }, values, f.options), /AI_OWNER_MISMATCH/);
  await fs.writeFile(path.join(f.shared, "ai-configuration.lock"), "Fixture lock");
  await assert.rejects(mail.configureMail(f.c, values, f.options), /AI_CONFIGURATION_BUSY/);
  assert.equal(f.calls.some(call => call[1] === "restart"), false);
});

test("mail read does not contact SMTP, failed delivery is safe and never restarts or changes env", async t => {
  const f = await fixture(t); await mail.configureMail(f.c, values, f.options);
  const before = await fs.readFile(path.join(f.shared, "ai.env")), restarts = f.calls.filter(call => call[1] === "restart").length;
  const result = await mail.testMail(f.c, "target@example.invalid", { ...f.options, send: async () => ({ errorCode: "MAIL_AUTH_FAILED", SMTP_PASS: values.SMTP_PASS }) });
  assert.equal(result.phase, "test_failed"); assert.equal(result.errorCode, "MAIL_AUTH_FAILED"); assert.equal(JSON.stringify(result).includes(values.SMTP_PASS), false);
  assert.deepEqual(await fs.readFile(path.join(f.shared, "ai.env")), before); assert.equal(f.calls.filter(call => call[1] === "restart").length, restarts);
  await assert.rejects(mail.testMail(f.c, "one@a.invalid,two@b.invalid", f.options), /MAIL_RECIPIENT_INVALID/);
});

test("mail service exact target/policy, stdin bundle, safe receipt and credential cleanup", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-mail-service-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-mail-service-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  for (const file of ["configure-lms-ai.cjs", "configure-lms-mail.cjs", "support-contact-upgrade.cjs"]) await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts", file), path.join(root, "infra/scripts", file));
  const target = { host: "192.0.2.90", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/mail-fixture", fingerprint: "SHA256:" + "A".repeat(43) };
  const saved = { id: crypto.randomUUID(), releaseId: crypto.randomUUID(), clientId: crypto.randomUUID(), phase: "succeeded", target, webPort: 3000 }, calls = [];
  let allowed = true, fail = false;
  const service = new MailConfigurationService(root, { withSession: async (_target, _auth, run) => run({ execute: async (command, script) => {
    calls.push({ command, script }); if (fail) throw Error(values.SMTP_PASS);
    return JSON.stringify({ ...values, clientId: saved.clientId, jobId: saved.id, releaseId: saved.releaseId, phase: "applied", updatedAt: new Date().toISOString(), passwordPresent: true, configured: true, smtpVerified: true });
  } }) }, { get: async () => saved }, async () => allowed);
  for (const patch of [{ host: "192.0.2.91" }, { port: 23 }, { username: "other" }, { basePath: "/srv/other" }, { fingerprint: "SHA256:" + "B".repeat(43) }]) await assert.rejects(service.execute(saved.clientId, { ...target, ...patch }, { mode: "password" }, "apply", { ...values }));
  allowed = false; await assert.rejects(service.execute(saved.clientId, target, { mode: "password" }, "apply", { ...values })); allowed = true;
  assert.equal(calls.length, 0);
  const input = { ...values }, auth = { mode: "password", password: "ssh-fixture-password" };
  const result = await service.execute(saved.clientId, target, auth, "apply", input);
  assert.equal(calls[0].command, "node -"); assert.ok(calls[0].script.includes(JSON.stringify(values.SMTP_PASS))); assert.equal(calls[0].script.includes("ssh-fixture-password"), false);
  assert.doesNotThrow(() => new (require("node:vm").Script)(calls[0].script));
  assert.equal(input.SMTP_PASS, undefined); assert.equal(auth.password, undefined); assert.equal(result.smtpVerified, false);
  const receipt = await fs.readFile(path.join(root, "infra/runtime/mail-configuration", saved.clientId + ".json"), "utf8"); assert.equal(receipt.includes(values.SMTP_PASS), false); assert.equal(JSON.stringify(result).includes(values.SMTP_PASS), false);
  fail = true; await assert.rejects(service.execute(saved.clientId, target, { mode: "password" }, "apply", { ...values }), error => !error.message.includes(values.SMTP_PASS));
  assert.equal((await service.get(saved.clientId)).phase, "needs_attention");
});
