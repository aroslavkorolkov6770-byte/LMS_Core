const test = require("node:test");
const assert = require("node:assert/strict");
const { validateClients, KEEP, TEMPORARY } = require("../../../infra/maintenance/cleanup-local-test-clients-20261031.cjs");
const real = { id: KEEP, name: "\u0420\u0443\u0441\u043b\u0430\u043d" };
test("one-off cleanup targets only four known temporary IDs, never Ruslan", () => {
  const ids = validateClients([real, ...TEMPORARY.map(id => ({ id, name: "fixture" }))]);
  assert.equal(ids.length, 4); assert.equal(ids.includes(KEEP), false);
});
test("unexpected client or changed real identity refuses deletion", () => {
  assert.throws(() => validateClients([real, { id: "other", name: "another real client" }]), /UNEXPECTED_CLIENT/);
  assert.throws(() => validateClients([{ ...real, name: "changed" }]), /RUSLAN_IDENTITY/);
  assert.throws(() => validateClients([{ ...real, id: "other" }]), /RUSLAN_IDENTITY/);
});
test("duplicate Ruslan display name does not qualify as a safe deletion plan", () => {
  assert.throws(() => validateClients([real, { id: TEMPORARY[0], name: real.name }]), /RUSLAN_IDENTITY/);
});
test("already-clean database produces an empty deletion list", () => {
  assert.deepEqual(validateClients([real]), []);
});
