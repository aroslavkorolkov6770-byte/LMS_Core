const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { IpPublicationService } = require("../dist/ip-publication.js");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-ip-service-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-ip-service-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts/publish-lms-ip.cjs"), path.join(root, "infra/scripts/publish-lms-ip.cjs"));
  const target = { host: "192.0.2.50", port: 22, username: "root", basePath: "/srv/lms-core/clients", appPath: "/srv/lms-core/clients/fixture", fingerprint: "SHA256:" + "A".repeat(43) };
  const saved = { id: randomUUID(), releaseId: randomUUID(), clientId: randomUUID(), phase: "succeeded", target, webPort: 3000 };
  const calls = [], mode = { allowed: true, fail: false, result: {} };
  const service = new IpPublicationService(root, { withSession: async (_target, _auth, action) => action({ execute: async (command, input, timeout) => {
    calls.push({ command, input, timeout }); if (mode.fail) throw Error("fixture transport error");
    return JSON.stringify({ clientId: saved.clientId, jobId: saved.id, releaseId: saved.releaseId, host: target.host, phase: "succeeded", url: "https://foreign.invalid", updatedAt: new Date().toISOString(), password: "fixture-secret", ...mode.result });
  } }) }, { get: async () => saved }, async () => mode.allowed);
  return { root, target, saved, calls, mode, service };
}

test("publication is bound to succeeded installation and exact SSH target/policy", async (t) => {
  const f = await fixture(t);
  for (const key of ["host", "port", "username", "basePath", "fingerprint"]) await assert.rejects(f.service.execute(f.saved.clientId, { ...f.target, [key]: key === "port" ? 23 : key === "host" ? "192.0.2.51" : key === "basePath" ? "/srv/another" : key === "fingerprint" ? "SHA256:" + "B".repeat(43) : "another" }, { mode: "password" }));
  f.mode.allowed = false; await assert.rejects(f.service.execute(f.saved.clientId, f.target, { mode: "password" }));
  f.mode.allowed = true; f.saved.phase = "build"; await assert.rejects(f.service.execute(f.saved.clientId, f.target, { mode: "password" }));
  assert.equal(f.calls.length, 0);
});

test("successful publication persists public fields only and removes the credential copy", async (t) => {
  const f = await fixture(t), auth = { mode: "password", password: "fixture-secret" };
  const state = await f.service.execute(f.saved.clientId, f.target, auth);
  assert.equal(state.url, "http://192.0.2.50"); assert.equal(auth.password, undefined);
  assert.equal(f.calls[0].command, "node -"); assert.equal(f.calls[0].input.includes("fixture-secret"), false);
  const text = await fs.readFile(path.join(f.root, "infra/runtime/ip-publications", f.saved.clientId + ".json"), "utf8");
  assert.equal(text.includes("fixture-secret"), false); assert.equal(text.includes("foreign.invalid"), false);
  assert.equal((await f.service.get(f.saved.clientId)).phase, "succeeded");
  await f.service.execute(f.saved.clientId, f.target, { mode: "password" }, true);
  assert.ok(f.calls[1].input.includes("checkIpPublication({"));
});

test("disconnect never reports success and requires a check before another mutation", async (t) => {
  const f = await fixture(t); f.mode.fail = true;
  await assert.rejects(f.service.execute(f.saved.clientId, f.target, { mode: "password" }));
  assert.equal((await f.service.get(f.saved.clientId)).phase, "needs_attention");
  await assert.rejects(f.service.execute(f.saved.clientId, f.target, { mode: "password" }), /Сначала нажмите/);
  assert.equal(f.calls.length, 1);
  f.mode.fail = false;
  assert.equal((await f.service.execute(f.saved.clientId, f.target, { mode: "password" }, true)).phase, "succeeded");
});

test("HTTPS uses the explicit worker, preserves its protocol/expiry, and never persists private fields", async t => {
  const f = await fixture(t), expiresAt = new Date(Date.now() + 160 * 3600000).toISOString();
  f.mode.result = { protocol: "https", expiresAt, autoRenew: true, renewalState: "scheduled", stagingCheck: "unavailable", privateKey: "never-persist", tlsCertificate: "never-persist" };
  const auth = { mode: "password", password: "fixture-secret" };
  const state = await f.service.execute(f.saved.clientId, f.target, auth, false, true);
  assert.equal(state.url, "https://192.0.2.50"); assert.equal(state.httpOnlyTest, false); assert.equal(state.expiresAt, expiresAt); assert.equal(state.autoRenew, true);
  assert.equal(auth.password, undefined); assert.ok(f.calls[0].input.includes('enableIpHttps({') && f.calls[0].input.includes('"acmeAgreement":true'));
  assert.equal(state.stagingCheck, "unavailable");
  assert.equal(f.calls[0].timeout, 2400000);
  const text = await fs.readFile(path.join(f.root, "infra/runtime/ip-publications", f.saved.clientId + ".json"), "utf8");
  assert.equal(/never-persist|fixture-secret|foreign.invalid/.test(text), false);
  assert.equal((await f.service.get(f.saved.clientId)).url, state.url);
  assert.equal((await f.service.get(f.saved.clientId)).stagingCheck, "unavailable");
  f.mode.result.expiresAt = new Date(Date.now() + 200 * 3600000).toISOString();
  assert.equal((await f.service.execute(f.saved.clientId, f.target, { mode: "password" }, true)).expiresAt, f.mode.result.expiresAt);
});

test("expired HTTPS remains HTTPS and can be repaired after an explicit server result", async t => {
  const f = await fixture(t);
  f.mode.result = { protocol: "https", phase: "needs_attention", errorCode: "TLS_CERTIFICATE_EXPIRED", expiresAt: new Date(Date.now() - 1000).toISOString(), autoRenew: false, renewalState: "inactive" };
  const checked = await f.service.execute(f.saved.clientId, f.target, { mode: "password" }, true);
  assert.equal(checked.url, "https://192.0.2.50"); assert.equal(checked.phase, "needs_attention");
  f.mode.result = { protocol: "https", autoRenew: true, renewalState: "ok", expiresAt: new Date(Date.now() + 86400000).toISOString() };
  assert.equal((await f.service.execute(f.saved.clientId, f.target, { mode: "password" }, false, true)).phase, "succeeded");
  await assert.rejects(f.service.execute(f.saved.clientId, f.target, { mode: "password" }, true, true));
});

test("stored HTTPS success becomes attention after expiry without opening an SSH session", async t => {
  const f = await fixture(t), file = path.join(f.root, "infra/runtime/ip-publications", f.saved.clientId + ".json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ clientId: f.saved.clientId, jobId: f.saved.id, releaseId: f.saved.releaseId, host: f.target.host, phase: "succeeded", updatedAt: new Date().toISOString(), protocol: "https", autoRenew: true, renewalState: "ok", expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const result = await f.service.get(f.saved.clientId);
  assert.equal(result.phase, "needs_attention"); assert.equal(result.errorCode, "TLS_CERTIFICATE_EXPIRED"); assert.equal(result.url, "https://192.0.2.50"); assert.equal(f.calls.length, 0);
});
