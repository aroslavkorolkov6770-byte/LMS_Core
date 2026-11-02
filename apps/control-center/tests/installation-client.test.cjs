const test = require("node:test");
const assert = require("node:assert/strict");
const { installationDomain, installationClient, installationConfiguration, assertInstallationConfiguration } = require("../dist/installation-client.js");
const { normalizeFreshClient } = require("../../../packages/db/dist/src/index.js");
const raw = { id: "48108c63-f9b1-4f97-8f62-b7e145be058e", name: "Fixture", slug: "0001", domain: "https://188.127.237.167", brandName: "Fixture brand", tariff: "extended", industryTemplate: "coffee_shop", aiRequestsLimit: 500 };
test("HTTP(S) root URLs become hostnames without changing bare IP/domain values", () => {
  for (const value of ["188.127.237.167", "http://188.127.237.167", "https://188.127.237.167/"]) assert.equal(installationDomain(value), "188.127.237.167");
  assert.equal(installationDomain("  HTTPS://LMS.Example.COM/  "), "lms.example.com");
  assert.equal(installationDomain("client.example"), "client.example");
});
test("ambiguous or secret-bearing URLs are rejected without exposing their contents", () => {
  for (const value of ["https://name:private-secret@example.com", "https://example.com:3000", "https://example.com/path", "https://example.com?q=secret", "https://example.com/#secret", "ftp://example.com", "//example.com", "", null, "example..com", "https://example.com\\path", "example.com\n"]) {
    assert.throws(() => installationDomain(value), error => error.message.includes("Домен / IP") && !error.message.includes("private-secret"));
  }
});
test("actual card-shaped URL passes the unchanged strict database normalizer; input is not mutated", () => {
  assert.throws(() => normalizeFreshClient(raw), /INVALID_CLIENT_CONFIG/);
  const source = { ...raw, password: "do-not-pass", otherUiField: true }, before = JSON.stringify(source);
  const result = installationClient(source, normalizeFreshClient);
  assert.equal(result.domain, "188.127.237.167"); assert.equal(result.id, raw.id);
  assert.equal(result.password, undefined); assert.equal(JSON.stringify(source), before);
});
test("other invalid client configuration gets a readable local error", () => {
  assert.throws(() => installationClient({ ...raw, tariff: "unsupported" }, normalizeFreshClient), /проверьте название/);
});

test("configuration snapshot uses normalized public fields only and detects every material change", () => {
  const client = installationClient(raw, normalizeFreshClient);
  const saved = installationConfiguration({ ...client, password: "fixture-secret", apiKey: "fixture-secret", updatedAt: "different", notes: "operator-only" });
  assert.ok(!JSON.stringify(saved).includes("fixture-secret")); assert.ok(!JSON.stringify(saved).includes("operator-only"));
  assert.doesNotThrow(() => assertInstallationConfiguration(saved, { ...client, notes: "another note" }));
  assert.doesNotThrow(() => assertInstallationConfiguration(saved, installationClient({ ...raw, domain: "HTTP://188.127.237.167/" }, normalizeFreshClient)));
  for (const [key, value] of Object.entries({ name: "Another", brandName: "Another brand", tariff: "base", industryTemplate: "coffee_retail", domain: "other.example", includedUsers: 999, maxAdmins: 999, aiRequestsLimit: 999, primaryColor: "#112233" })) {
    assert.throws(() => assertInstallationConfiguration(saved, { ...client, [key]: value }), /Карточка клиента изменилась/);
  }
  assert.throws(() => assertInstallationConfiguration(undefined, client), /полного снимка/);
  assert.throws(() => assertInstallationConfiguration({ ...saved, client: { ...client, name: "changed on disk" } }, client), /полного снимка/);
});
