const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const ai = require("../../../infra/scripts/configure-lms-ai.cjs");
const { provisionAi } = require("../../../infra/scripts/provision-lms-ai.cjs");
const { normalizeAiProvisionInput, AiConfigurationService } = require("../dist/ai-configuration.js");
const ui = require("../renderer/ai-configuration.js");
const settings = { AI_PROJECT_ID: "fixture-folder", AI_PROMPT_ID: "fixture-prompt" };
const token = "fixture-private-provider-token";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-ai-provision-"));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("core-ai-provision-")); await fs.rm(root, { recursive: true, force: true }); });
  const c = { clientId: crypto.randomUUID(), jobId: crypto.randomUUID(), releaseId: crypto.randomUUID(), operationId: crypto.randomUUID(), appPath: "/srv/lms-core/clients/provision-fixture", webPort: 23901 };
  const disk = p => path.join(root, p), appRoot = disk(c.appPath), app = path.join(appRoot, "releases", c.releaseId, "lms"), shared = path.join(appRoot, "shared");
  await fs.mkdir(path.join(app, "app/lib"), { recursive: true }); await fs.mkdir(shared); await fs.mkdir(disk("/etc/systemd/system"), { recursive: true });
  const user = "lms-" + crypto.createHash("sha256").update(c.clientId).digest("hex").slice(0, 20), unit = "lms-provision-fixture-web.service";
  await fs.writeFile(path.join(appRoot, ".core-install-owner.json"), JSON.stringify({ ...c, state: "installed", services: [unit] }));
  await fs.writeFile(path.join(shared, "runtime-context.json"), JSON.stringify({ clientId: c.clientId, releaseId: c.releaseId, releaseRoot: `${c.appPath}/releases/${c.releaseId}`, webPort: c.webPort }));
  await fs.symlink(path.dirname(app), path.join(appRoot, "current"), "junction");
  await fs.writeFile(path.join(app, "app/lib/aliceAi.ts"), "getAliceAiConfig AI_API_KEY AI_PROJECT_ID AI_PROMPT_ID AI_VECTOR_STORE_ID");
  await fs.writeFile(disk(`/etc/systemd/system/${unit}`), `User=${user}\nExecStart=/usr/bin/node ${c.appPath}/releases/${c.releaseId}/backend/runtime-process.cjs ${c.appPath}/shared/runtime-context.json web\n`);
  const env = "UNRELATED=retained\nAI_API_KEY=" + token + "\nAI_PROJECT_ID=old-folder\nAI_PROMPT_ID=0001\nAI_VECTOR_STORE_ID=0001\n";
  await fs.writeFile(path.join(app, ".env.production.local"), env);
  const state = { stores: [], calls: [], lost: false, reject: 0, failRestart: false, unhealthy: false, hide: false, malformed: false };
  const json = value => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) });
  const options = { ai, root, fixture: true, account: { uid: 0, gid: 0 }, attempts: 1, delayMs: 1,
    fetch: async () => ({ ok: !state.unhealthy, json: async () => ({ protocol: "lms-core-client-v1", status: "ok", clientId: c.clientId, releaseId: c.releaseId }) }),
    run: async (_file, args) => { if (args[0] === "restart" && state.failRestart) { state.failRestart = false; throw Error("fixture restart"); } },
    cloudFetch: async (url, request) => {
      assert.equal(request.headers.Authorization, "Bearer " + token); assert.equal(request.headers["OpenAI-Project"], settings.AI_PROJECT_ID);
      assert.equal(request.redirect, "error"); assert.ok(request.signal); assert.ok(url.startsWith("https://ai.api.cloud.yandex.net/v1/vector_stores"));
      state.calls.push({ url, method: request.method, body: request.body ? JSON.parse(request.body) : null });
      if (state.reject) return { ok: false, status: state.reject, text: async () => { throw Error("provider error body must not be read " + token); } };
      if (request.method === "POST") {
        const body = JSON.parse(request.body); assert.deepEqual(body.file_ids, []);
        const item = { id: "fixture-index-" + crypto.randomUUID(), object: "vector_store", status: "completed", metadata: body.metadata };
        state.stores.push(item);
        if (state.lost) { state.lost = false; throw Error("network lost " + token); }
        if (state.malformed) return { ok: true, text: async () => "not json " + token };
        return json(item);
      }
      if (url.includes("?")) return json({ data: state.hide ? [] : state.stores, has_more: false });
      const id = decodeURIComponent(url.split("/").at(-1)); return json(state.stores.find(item => item.id === id));
    } };
  const call = () => provisionAi({ ...c, operationId: crypto.randomUUID() }, { ...settings }, options);
  return { c, app, shared, env, state, call, options, root };
}
test("Core automatic mode requires folder/prompt, ignores a stale manual vector ID, and never implies generation", () => {
  assert.equal(ui.validate({ ...settings, AI_VECTOR_STORE_ID: "0001" }, true, true), null);
  assert.equal(ui.validate({ ...settings, AI_PROMPT_ID: "0001" }, true, true).id, "ai-prompt-id");
  assert.equal(normalizeAiProvisionInput({ ...settings, AI_VECTOR_STORE_ID: "foreign", API_KEY: token }).AI_VECTOR_STORE_ID, "core-auto-pending");
  assert.equal(JSON.stringify(normalizeAiProvisionInput(settings)).includes(token), false);
});
test("creates an empty client-owned index with the server key and applies it without changing source", async t => {
  const f = await fixture(t), source = await fs.readFile(path.join(f.app, "app/lib/aliceAi.ts"));
  const result = await f.call(); assert.equal(result.phase, "applied"); assert.equal(result.indexId, f.state.stores[0].id); assert.equal(result.providerVerified, false);
  assert.deepEqual(f.state.calls.map(call => call.method), ["GET", "POST"]); assert.equal(JSON.stringify(result).includes(token), false);
  const applied = require("node:util").parseEnv(await fs.readFile(path.join(f.shared, "ai.env"), "utf8"));
  assert.equal(applied.AI_VECTOR_STORE_ID, result.indexId); assert.equal(applied.UNRELATED, "retained"); assert.equal(applied.AI_API_KEY, token);
  assert.deepEqual(await fs.readFile(path.join(f.app, "app/lib/aliceAi.ts")), source);
  const again = await f.call(); assert.equal(again.phase, "applied"); assert.equal(again.indexReused, true); assert.equal(f.state.stores.length, 1);
});
test("lost POST response is reconciled through ownership metadata without a second POST", async t => {
  const f = await fixture(t); f.state.lost = true;
  const first = await f.call(); assert.equal(first.phase, "needs_attention"); assert.equal(first.errorCode, "AI_INDEX_CREATION_UNCONFIRMED");
  assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), f.env);
  const second = await f.call(); assert.equal(second.phase, "applied"); assert.equal(second.indexReused, true);
  assert.equal(f.state.calls.filter(call => call.method === "POST").length, 1);
});
test("an unknown creation absent from listing cannot trigger blind retries", async t => {
  const f = await fixture(t); f.state.lost = true; await f.call(); f.state.hide = true;
  const result = await f.call(); assert.equal(result.phase, "needs_attention"); assert.equal(f.state.calls.filter(call => call.method === "POST").length, 1);
});
test("authentication and permission errors never read provider text or replace the old env", async t => {
  for (const status of [400, 401, 403, 429, 500]) {
    const f = await fixture(t); f.state.reject = status;
    const result = await f.call(); assert.equal(result.phase, "failed"); assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), f.env); assert.equal(f.state.calls.length, 1);
  }
});
test("failed env application retains its created index and retry reuses it", async t => {
  const f = await fixture(t); f.state.failRestart = true;
  const first = await f.call(); assert.equal(first.phase, "failed"); assert.equal(first.rollbackRestored, true); assert.ok(first.indexId);
  assert.equal(await fs.readFile(path.join(f.app, ".env.production.local"), "utf8"), f.env);
  const second = await f.call(); assert.equal(second.phase, "applied"); assert.equal(second.indexReused, true); assert.equal(f.state.stores.length, 1);
});
test("foreign, expired and ambiguous resources never get silently adopted", async t => {
  const f = await fixture(t); f.state.stores.push({ id: "foreign-index", object: "vector_store", status: "completed", metadata: { managed_by: "lms_core", client_id: crypto.randomUUID() } });
  assert.equal((await f.call()).phase, "applied"); assert.equal(f.state.stores.length, 2);
  f.state.stores.at(-1).metadata.client_id = crypto.randomUUID(); assert.equal((await f.call()).errorCode, "AI_INDEX_OWNER_MISMATCH");
  const g = await fixture(t), owned = { id: "expired-index", object: "vector_store", status: "completed", expires_at: 1234, metadata: { managed_by: "lms_core", client_id: g.c.clientId } };
  g.state.stores.push(owned); assert.equal((await g.call()).errorCode, "AI_INDEX_EXPIRATION_UNSUPPORTED");
  delete owned.expires_at; g.state.stores.push({ ...owned, id: "another-index" }); assert.equal((await g.call()).errorCode, "AI_INDEX_MULTIPLE_OWNED");
  assert.ok(!g.state.calls.some(call => call.method === "POST"));
});

test("empty optional expiry object is not a retention policy; a real policy still blocks", async t => {
  const f = await fixture(t);
  f.state.stores.push({ id: "empty-expiry-index", object: "vector_store", status: "completed", expires_after: {}, expires_at: null, metadata: { managed_by: "lms_core", client_id: f.c.clientId } });
  assert.equal((await f.call()).phase, "applied");
  f.state.stores[0].expires_after = { anchor: "", days: 0 };
  assert.equal((await f.call()).phase, "applied");
  f.state.stores[0].expires_after = { anchor: "last_active_at", days: 0 };
  assert.equal((await f.call()).phase, "applied");
  f.state.stores[0].expires_at = 9999999999;
  assert.equal((await f.call()).errorCode, "AI_INDEX_EXPIRATION_UNSUPPORTED");
  f.state.stores[0].expires_at = null;
  f.state.stores[0].expires_after = { anchor: "not_set", days: 0, valid: false };
  f.state.stores[0].expires_at = -6795364579;
  assert.equal((await f.call()).phase, "applied");
  f.state.stores[0].expires_after.valid = true;
  assert.equal((await f.call()).errorCode, "AI_INDEX_EXPIRATION_UNSUPPORTED");
  f.state.stores[0].expires_after.valid = false; f.state.stores[0].expires_at = 9999999999;
  assert.equal((await f.call()).errorCode, "AI_INDEX_EXPIRATION_UNSUPPORTED");
  f.state.stores[0].expires_at = Number("9223372036854775807");
  assert.equal((await f.call()).phase, "applied");
  f.state.stores[0].expires_at = 1793470989000000000;
  assert.equal((await f.call()).phase, "applied");
  f.state.stores[0].expires_after.valid = true;
  assert.equal((await f.call()).errorCode, "AI_INDEX_EXPIRATION_UNSUPPORTED");
  f.state.stores[0].expires_after.valid = false;
  f.state.stores[0].expires_at = null;
  f.state.stores[0].expires_after = { anchor: "", days: 0, unknown: true };
  assert.equal((await f.call()).errorCode, "AI_INDEX_EXPIRATION_UNSUPPORTED");
  f.state.stores[0].expires_after = { anchor: "last_active_at", days: 7 };
  const rejected = await f.call(); assert.equal(rejected.errorCode, "AI_INDEX_EXPIRATION_UNSUPPORTED"); assert.equal(rejected.indexExpiryDays, 7);
  assert.equal(rejected.indexId, "empty-expiry-index"); assert.equal(rejected.indexReused, true);
  assert.ok(!f.state.calls.some(call => call.method === "POST"));
});
test("LMS health and malformed creation responses fail safely", async t => {
  const f = await fixture(t); f.state.unhealthy = true; assert.equal((await f.call()).errorCode, "AI_LMS_HEALTH_FAILED"); assert.equal(f.state.calls.length, 0);
  f.state.unhealthy = false; f.state.malformed = true;
  assert.equal((await f.call()).phase, "needs_attention"); assert.equal((await f.call()).phase, "applied"); assert.equal(f.state.stores.length, 1);
});

test("native service bundles the reusable worker, whitelists receipt and clears credentials", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-ai-native-"));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("core-ai-native-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  for (const name of ["configure-lms-ai.cjs", "provision-lms-ai.cjs"]) await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts", name), path.join(root, "infra/scripts", name));
  const clientId = crypto.randomUUID(), target = { host: "192.0.2.45", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/native-fixture", fingerprint: "SHA256:" + "A".repeat(43) };
  const installed = { id: crypto.randomUUID(), releaseId: crypto.randomUUID(), clientId, phase: "succeeded", target, webPort: 3000 };
  let sends = 0;
  const service = new AiConfigurationService(root, { withSession: async (_target, _auth, action) => action({ execute: async (command, script) => {
    sends++; assert.equal(command, "node -"); assert.match(script, /provision\.provisionAi/); new (require("node:vm").Script)(script);
    return JSON.stringify({ clientId, jobId: installed.id, releaseId: installed.releaseId, phase: "applied", ...settings, AI_VECTOR_STORE_ID: "fixture-auto-index", indexId: "fixture-auto-index", indexReused: true, provisionMode: "core_vector_store", AI_API_KEY: token, apiKeyPresent: true, configured: true, providerVerified: true, updatedAt: new Date().toISOString() });
  } }) }, { get: async () => installed }, async () => true);
  const input = { ...settings, AI_API_KEY: token, AI_VECTOR_STORE_ID: "0001" }, auth = { mode: "password", password: "fixture-ssh-private" };
  const result = await service.execute(clientId, target, auth, input, false, true);
  assert.equal(result.indexId, "fixture-auto-index"); assert.equal(result.providerVerified, false); assert.equal(input.AI_API_KEY, undefined); assert.equal(auth.password, undefined);
  assert.equal(JSON.stringify(await service.get(clientId)).includes(token), false);
  await assert.rejects(service.execute(clientId, { ...target, host: "192.0.2.46" }, { mode: "password" }, settings, false, true)); assert.equal(sends, 1);
});
