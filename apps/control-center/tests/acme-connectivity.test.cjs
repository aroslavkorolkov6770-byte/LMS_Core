const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { checkAcmeDirectory } = require("../../../infra/scripts/publish-lms-ip.cjs");
const address = "https://acme-v02.api.letsencrypt.org/directory";
function fakeGet(mode = {}) {
  return (options, callback) => {
    assert.equal(options.hostname, "acme-v02.api.letsencrypt.org"); assert.equal(options.path, "/directory"); assert.equal(options.family, 4);
    assert.equal(options.rejectUnauthorized, undefined); assert.equal(options.checkServerIdentity, undefined);
    const request = new EventEmitter(); request.destroy = () => {};
    process.nextTick(() => {
      if (mode.error) { request.emit("error", Object.assign(Error("private diagnostic must not escape"), { code: mode.error })); return; }
      if (mode.hang) return;
      const response = new EventEmitter(); response.statusCode = mode.status || 200; response.resume = () => {};
      callback(response);
      const body = { newNonce: new URL("/acme/new-nonce", address).href, newAccount: new URL("/acme/new-acct", address).href, newOrder: new URL("/acme/new-order", address).href, meta: { profiles: { shortlived: "supported" } }, ...mode.body };
      response.emit("data", JSON.stringify(body)); response.emit("end");
    });
    return request;
  };
}
test("a directory probe keeps TLS verification and accepts only official same-origin ACME endpoints and the IP profile", async () => {
  assert.equal((await checkAcmeDirectory(address, { get: fakeGet() })).ready, true);
  assert.throws(() => checkAcmeDirectory("https://foreign.invalid/directory", { get: fakeGet() }), /ACME_DIRECTORY_INVALID/);
  assert.equal((await checkAcmeDirectory(address, { get: fakeGet({ body: { newOrder: "https://foreign.invalid/order" } }) })).errorCode, "ACME_DIRECTORY_INVALID");
  assert.equal((await checkAcmeDirectory(address, { get: fakeGet({ body: { meta: { profiles: {} } } }) })).errorCode, "ACME_PROFILE_UNAVAILABLE");
});
test("network timeout is availability failure, but certificate trust failures cannot enable fallback", async () => {
  for (const mode of [{ error: "ETIMEDOUT" }, { error: "ENETUNREACH" }, { status: 503 }, { hang: true }]) {
    const result = await checkAcmeDirectory(address, { get: fakeGet(mode), timeout: 10 });
    assert.equal(result.unavailable, true); assert.equal(result.errorCode, "ACME_CONNECTION_FAILED");
    assert.ok(!JSON.stringify(result).includes("private diagnostic"));
  }
  const tls = await checkAcmeDirectory(address, { get: fakeGet({ error: "CERT_HAS_EXPIRED" }) });
  assert.equal(tls.unavailable, false); assert.equal(tls.errorCode, "ACME_DIRECTORY_TLS_FAILED");
});
