const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { normalizeSettings, upsertEnv, configureAi, inspectAi } = require("../../../infra/scripts/configure-lms-ai.cjs");
const { normalizeAiInput, AiConfigurationService } = require("../dist/ai-configuration.js");
const ids = { AI_PROJECT_ID: "fixture-project", AI_PROMPT_ID: "fixture-prompt", AI_VECTOR_STORE_ID: "fixture-vector" };
const settings = { ...ids, AI_API_KEY: "fixture-alice-key-DO-NOT-LOG" };
const aiUi = require("../renderer/ai-configuration.js");

test("AI input accepts only server-side fields and rejects dotenv injection", () => {
  assert.deepEqual(normalizeAiInput({ ...settings, password: "not-forwarded", NEXT_PUBLIC_AI_API_KEY: "not-forwarded" }), settings);
  for (const token of ["x\nDATABASE_URL=evil", "Bearer key", '"key"', "$EXPAND", "x".repeat(8193)]) {
    assert.throws(() => normalizeAiInput({ ...ids, AI_API_KEY: token }));
    assert.throws(() => normalizeSettings({ ...ids, AI_API_KEY: token }));
  }
  assert.deepEqual(normalizeSettings({ ...ids, AI_API_KEY: "" }, settings), settings);
  assert.throws(() => normalizeSettings(ids), /AI_TOKEN_REQUIRED/);
});
test("AI UI validates fields and never formats a token returned by an untrusted extra property", () => {
  assert.equal(aiUi.validate(settings, false), null);
  assert.equal(aiUi.validate({ ...ids, AI_API_KEY: "" }, true), null);
  assert.equal(aiUi.validate({ ...ids, AI_API_KEY: "" }, false).id, "ai-api-key");
  assert.equal(aiUi.validate({ ...settings, AI_PROMPT_ID: "" }, false).id, "ai-prompt-id");
  assert.equal(aiUi.formatResult({ ...settings, phase: "applied", apiKeyPresent: true }).includes(settings.AI_API_KEY), false);
});

test("numeric client codes are not accepted as provider resource identifiers", () => {
  for (const [key, id] of Object.entries({ AI_PROJECT_ID: "ai-project-id", AI_PROMPT_ID: "ai-prompt-id", AI_VECTOR_STORE_ID: "ai-vector-store-id" })) {
    const bad = { ...settings, [key]: "0001" };
    assert.equal(aiUi.validate(bad, true).id, id);
    assert.match(aiUi.validate(bad, true).message, /одного API-ключа недостаточно/);
    assert.throws(() => normalizeAiInput(bad), /0001/);
    assert.throws(() => normalizeSettings(bad), /AI_IDS_PLACEHOLDER/);
  }
  const result = aiUi.formatResult({ ...ids, AI_PROMPT_ID: "0001", phase: "applied", apiKeyPresent: true });
  assert.match(result, /Подключение к ИИ НЕ проверено/);
  assert.match(result, /Номер клиента/);
});

test("AI dotenv upsert preserves unrelated text, multiline values, and comments", () => {
  const client = randomUUID();
  const original = '# keep me\r\nDATABASE_URL="postgres://fixture:private@localhost/db"\r\nOTHER="line one\nAI_API_KEY=inside-another-value\nline three"\nexport AI_API_KEY="old\nsecret"\nAI_PROJECT_ID=old\nTAIL=value\n';
  const result = upsertEnv(original, settings, client);
  assert.ok(result.includes('DATABASE_URL="postgres://fixture:private@localhost/db"\r\n'));
  assert.ok(result.includes('OTHER="line one\nAI_API_KEY=inside-another-value\nline three"\n'));
  assert.ok(result.includes("TAIL=value\n")); assert.equal(result.includes('export AI_API_KEY="old'), false);
  assert.equal(require("node:util").parseEnv(result).AI_API_KEY, settings.AI_API_KEY);
  assert.equal(upsertEnv(result, settings, client), result);
  assert.throws(() => upsertEnv('OTHER="unfinished\n', settings, client), /AI_ENV_FORMAT_UNSUPPORTED/);
});

async function workerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-ai-worker-"));
  const c = { clientId: randomUUID(), jobId: randomUUID(), releaseId: randomUUID(), operationId: randomUUID(), appPath: "/srv/lms-core/clients/ai-fixture", webPort: 23451 };
  const disk = p => path.join(root, p), appRoot = disk(c.appPath), release = path.join(appRoot, "releases", c.releaseId), app = path.join(release, "lms"), shared = path.join(appRoot, "shared");
  await fs.mkdir(path.join(app, "app/lib"), { recursive: true }); await fs.mkdir(shared); await fs.mkdir(disk("/etc/systemd/system"), { recursive: true });
  const user = "lms-" + require("node:crypto").createHash("sha256").update(c.clientId).digest("hex").slice(0, 20), unit = "lms-ai-fixture-web.service";
  await fs.writeFile(path.join(appRoot, ".core-install-owner.json"), JSON.stringify({ ...c, state: "installed", services: [unit] }));
  await fs.writeFile(path.join(shared, "runtime-context.json"), JSON.stringify({ clientId: c.clientId, releaseId: c.releaseId, releaseRoot: `${c.appPath}/releases/${c.releaseId}`, webPort: c.webPort }));
  await fs.symlink(release, path.join(appRoot, "current"), "junction");
  await fs.writeFile(path.join(app, "app/lib/aliceAi.ts"), "getAliceAiConfig AI_API_KEY AI_PROJECT_ID AI_PROMPT_ID AI_VECTOR_STORE_ID");
  await fs.writeFile(disk(`/etc/systemd/system/${unit}`), `User=${user}\nExecStart=/usr/bin/node ${c.appPath}/releases/${c.releaseId}/backend/runtime-process.cjs ${c.appPath}/shared/runtime-context.json web\n`);
  const calls = [], state = { unhealthy: false, failNextRestart: false };
  const options = { fixture: true, root, account: { uid: 0, gid: 0 }, attempts: 1, delayMs: 1,
    run: async (file, args) => { calls.push([file, ...args]); if (args[0] === "restart" && state.failNextRestart) { state.failNextRestart = false; throw Error("test service unavailable"); } return ""; },
    fetch: async () => ({ ok: !state.unhealthy, json: async () => ({ protocol: "lms-core-client-v1", status: "ok", clientId: c.clientId, releaseId: c.releaseId }) }) };
  t.after(async () => { const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("core-ai-worker-")); await fs.rm(resolved, { recursive: true, force: true }); });
  return { c, options, app, shared, calls, state, unit };
}

test("AI worker writes protected shared env through a link, preserves unrelated variables, and never returns key", async t => {
  const f = await workerFixture(t);
  await fs.writeFile(path.join(f.app, ".env.production.local"), "UNRELATED_SETTING=keep-me\nAI_API_KEY=old-key\n");
  const refused = await configureAi(f.c, { ...settings, AI_PROMPT_ID: "0001" }, f.options);
  assert.equal(refused.phase, "failed"); assert.equal(refused.errorCode, "AI_IDS_PLACEHOLDER");
  assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), "UNRELATED_SETTING=keep-me\nAI_API_KEY=old-key\n");
  assert.equal(f.calls.some(call => call[1] === "restart"), false);
  const result = await configureAi(f.c, settings, f.options);
  assert.equal(result.phase, "applied"); assert.equal(result.configured, true); assert.equal(JSON.stringify(result).includes(settings.AI_API_KEY), false);
  assert.equal((await fs.lstat(path.join(f.app, ".env.production.local"))).isSymbolicLink(), true);
  assert.ok((await fs.readFile(path.join(f.shared, "ai.env"), "utf8")).includes("UNRELATED_SETTING=keep-me"));
  assert.deepEqual(f.calls.filter(call => call[1] === "restart"), [["systemctl", "restart", f.unit]]);
  const read = await inspectAi(f.c, f.options); assert.equal(read.apiKeyPresent, true); assert.equal(read.providerVerified, false); assert.equal(JSON.stringify(read).includes(settings.AI_API_KEY), false);
  const rotated = await configureAi({ ...f.c, operationId: randomUUID() }, { ...ids, AI_API_KEY: "fixture-new-key" }, f.options);
  assert.equal(rotated.phase, "applied");
  assert.equal((await fs.readdir(f.shared)).some(name => name.startsWith(".ai-original") || name.endsWith(".lock") || name.endsWith(".tmp")), false);
});

test("AI worker restores old env after restart failure instead of returning success", async t => {
  const f = await workerFixture(t), old = "KEEP=unchanged\nAI_API_KEY=old-fixture-key\n";
  await fs.writeFile(path.join(f.app, ".env.production.local"), old); f.state.failNextRestart = true;
  const result = await configureAi(f.c, settings, f.options);
  assert.equal(result.phase, "failed"); assert.equal(result.rollbackRestored, true);
  assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), old);
  assert.equal((await fs.lstat(path.join(f.app, ".env.production.local"))).isSymbolicLink(), false);
  await assert.rejects(fs.stat(path.join(f.shared, "ai.env")), { code: "ENOENT" });
});

test("AI worker refuses mismatched ownership and foreign dotenv links without restarting", async t => {
  const f = await workerFixture(t);
  await assert.rejects(configureAi({ ...f.c, jobId: randomUUID() }, settings, f.options), /AI_OWNER_MISMATCH/);
  const foreign = path.join(f.app, "foreign.env"); await fs.writeFile(foreign, "KEEP=private\n");
  await fs.symlink(foreign, path.join(f.app, ".env.production.local"));
  await assert.rejects(configureAi(f.c, settings, f.options), /AI_ENV_LINK_UNSAFE/);
  assert.equal(f.calls.some(call => call[1] === "restart"), false);
});

async function serviceFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-ai-service-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-ai-service-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true }); await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts/configure-lms-ai.cjs"), path.join(root, "infra/scripts/configure-lms-ai.cjs"));
  const target = { host: "192.0.2.90", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/ai-fixture", fingerprint: "SHA256:" + "A".repeat(43) };
  const saved = { id: randomUUID(), releaseId: randomUUID(), clientId: randomUUID(), phase: "succeeded", target, webPort: 3000 }, calls = [], mode = { allowed: true, fail: false };
  const service = new AiConfigurationService(root, { withSession: async (_target, _auth, action) => action({ execute: async (command, input) => {
    calls.push({ command, input }); if (mode.fail) throw Error(settings.AI_API_KEY);
    return JSON.stringify({ clientId: saved.clientId, jobId: saved.id, releaseId: saved.releaseId, phase: "applied", ...ids, AI_API_KEY: settings.AI_API_KEY, apiKeyPresent: true, configured: true, providerVerified: true, updatedAt: new Date().toISOString() });
  } }) }, { get: async () => saved }, async () => mode.allowed);
  return { root, target, saved, calls, mode, service };
}

test("AI service binds installed client and exact pinned target before sending the token", async t => {
  const f = await serviceFixture(t);
  for (const key of ["host", "port", "username", "basePath", "fingerprint"]) await assert.rejects(f.service.execute(f.saved.clientId, { ...f.target, [key]: key === "port" ? 23 : key === "host" ? "192.0.2.91" : key === "basePath" ? "/srv/other/clients" : key === "fingerprint" ? "SHA256:" + "B".repeat(43) : "other" }, { mode: "password" }, { ...settings }, false));
  f.mode.allowed = false; await assert.rejects(f.service.execute(f.saved.clientId, f.target, { mode: "password" }, { ...settings }, false));
  assert.equal(f.calls.length, 0);
});

test("AI service uses SSH stdin, redacts receipt and clears credential copies", async t => {
  const f = await serviceFixture(t), auth = { mode: "password", password: "fixture-ssh-secret" }, input = { ...settings };
  const result = await f.service.execute(f.saved.clientId, f.target, auth, input, false);
  assert.equal(f.calls[0].command, "node -"); assert.ok(f.calls[0].input.includes(settings.AI_API_KEY)); assert.equal(f.calls[0].input.includes("fixture-ssh-secret"), false);
  assert.equal(input.AI_API_KEY, undefined); assert.equal(auth.password, undefined); assert.equal(result.providerVerified, false);
  assert.equal(JSON.stringify(result).includes(settings.AI_API_KEY), false);
  assert.equal((await fs.readFile(path.join(f.root, "infra/runtime/ai-configuration", f.saved.clientId + ".json"), "utf8")).includes(settings.AI_API_KEY), false);
  f.mode.fail = true;
  await assert.rejects(f.service.execute(f.saved.clientId, f.target, { mode: "password" }, { ...settings }, false), error => !error.message.includes(settings.AI_API_KEY));
  assert.equal((await f.service.get(f.saved.clientId)).phase, "needs_attention");
  const file = path.join(f.root, "infra/runtime/ai-configuration", f.saved.clientId + ".json");
  const legacy = JSON.stringify({ ...result, AI_PROMPT_ID: "0001", configured: true });
  await fs.writeFile(file, legacy);
  assert.equal((await f.service.get(f.saved.clientId)).configured, false);
  assert.equal(await fs.readFile(file, "utf8"), legacy);
});
