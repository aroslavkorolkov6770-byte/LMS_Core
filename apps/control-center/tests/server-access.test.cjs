const test = require("node:test");
const assert = require("node:assert/strict");
const { createServerAccess, connectionKey } = require("../renderer/server-access.js");
const target = { host: "one.example", port: 22, username: "root", basePath: "/srv/lms-core/clients", fingerprint: "SHA256:" + "a".repeat(43) };
const pause = () => new Promise(resolve => setTimeout(resolve, 230));
function fixture() {
  const records = new Map(), calls = [], errors = [];
  let id = "client-a", current = {}, click, externalBusy = false, inputsDisabled = false;
  const field = { value: "", readOnly: false }, button = { dataset: {}, setAttribute(name, value) { this[name] = value; }, addEventListener(name, handler) { click = handler; } }, note = {};
  const get = (key) => records.get(key) || { clientId: key, revision: 0, target: null, passwords: {} };
  const publicValue = (value, selected = value.target) => ({ clientId: value.clientId, revision: value.revision, target: value.target, passwordSaved: !!selected && !!value.passwords[connectionKey(selected)] });
  const bridge = {
    getClientServer: async (key, selected) => publicValue(get(key), selected),
    saveClientServer: async (key, selected, revision) => { const value = get(key); assert.equal(value.revision, revision); value.revision++; value.target = { ...selected }; records.set(key, value); return publicValue(value); },
    toggleClientServerPassword: async (key, selected, password, revision, forget) => { const value = get(key); assert.equal(value.revision, revision); if (!forget && !password) throw Error("Введите пароль"); calls.push({ key, forget }); value.revision++; value.target = { ...selected }; if (forget) delete value.passwords[connectionKey(selected)]; else value.passwords[connectionKey(selected)] = password; records.set(key, value); return publicValue(value); }
  };
  const controller = createServerAccess({ bridge, clientId: () => id, readTarget: () => current, applyTarget: value => { current = value || {}; }, authMode: () => "password", field, button, note, onError: error => errors.push(error.message), isBusy: () => externalBusy, setLoading: value => { inputsDisabled = value; } });
  return { controller, records, bridge, field, button, calls, errors, click: () => click(), select: value => { id = value; }, target: value => { current = value; }, busy: value => { externalBusy = value; controller.refresh(); }, disabled: () => inputsDisabled };
}
test("lock/unlock and reopened controller restore metadata but never expose password", async () => {
  const f = fixture(); await f.controller.load(); f.target(target); f.field.value = "fixture-password"; f.click(); await pause();
  assert.equal(f.field.value, ""); assert.equal(f.field.readOnly, true); assert.equal(f.controller.isSaved(), true);
  await f.controller.load(); assert.equal(f.field.value, ""); assert.equal(f.button["aria-pressed"], "true");
  f.click(); await pause(); assert.equal(f.controller.isSaved(), false); assert.equal(f.field.readOnly, false); assert.equal(f.field.value, ""); assert.equal(f.calls.at(-1).forget, true);
});
test("client switch clears former host; changing hosts restores only a matching saved password", async () => {
  const f = fixture(); await f.controller.load(); f.target(target); f.field.value = "one"; f.click(); await pause();
  f.select("client-b"); await f.controller.load(); assert.equal(f.controller.isSaved(), false); assert.equal(f.field.value, "");
  f.select("client-a"); await f.controller.load(); assert.equal(f.controller.isSaved(), true);
  f.target({ ...target, host: "two.example" }); f.controller.changed(); await pause(); assert.equal(f.controller.isSaved(), false);
  f.target(target); f.controller.changed(); await pause(); assert.equal(f.controller.isSaved(), true);
});
test("failed password save preserves manual input; no auto saving on ordinary field input", async () => {
  const f = fixture(); await f.controller.load(); f.target(target); f.click(); await pause();
  assert.equal(f.errors.length, 1); assert.equal(f.calls.length, 0);
  f.field.value = "not-yet-saved"; assert.equal(f.records.size, 0);
});
test("late client profile response is ignored after switching", async () => {
  const f = fixture(); let release; const original = f.bridge.getClientServer;
  f.bridge.getClientServer = key => key === "client-a" ? new Promise(resolve => { release = resolve; }) : original(key);
  const pending = f.controller.load(); f.select("client-b"); await f.controller.load();
  release({ clientId: "client-a", revision: 8, target, passwordSaved: true }); await pending;
  assert.equal(f.controller.isSaved(), false); assert.equal(f.field.value, ""); assert.equal(f.field.readOnly, false);
});
test("API unavailable at startup can be retried without rebooting Core", async () => {
  const f = fixture(), original = f.bridge.getClientServer;
  f.bridge.getClientServer = async () => { throw Error("API offline"); };
  await f.controller.load(); assert.equal(f.disabled(), true); assert.equal(f.button.disabled, true);
  f.bridge.getClientServer = original;
  await f.controller.ensureLoaded(); assert.equal(f.disabled(), false); assert.equal(f.button.disabled, false);
});
test("a running remote action keeps lock and connection fields disabled", async () => {
  const f = fixture(); await f.controller.load(); f.target(target); f.field.value = "fixture-password";
  f.busy(true); assert.equal(f.button.disabled, true); assert.equal(f.disabled(), true);
  f.click(); await pause(); assert.equal(f.calls.length, 0);
  f.busy(false); assert.equal(f.button.disabled, false); assert.equal(f.disabled(), false);
});
