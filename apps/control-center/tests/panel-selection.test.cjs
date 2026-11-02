const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createPanelSelectionSession } = require("../renderer/panel-selection.js");
const ts = createRequire(path.resolve(__dirname, "../package.json"))("typescript");
const childModule = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../deploy-panel/app/client-selection-channel.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: childModule });
const { connectCoreClientSelection } = childModule;
const source = {}, origin = "http://127.0.0.1:3002";
function session(expected = "a") { let serial = 0; const state = createPanelSelectionSession(() => `session-${++serial}`); state.begin(expected); return state; }
function event(state, overrides = {}) { return { source, origin, data: { type: "lms-core:client-selection", version: 1, session: state.envelope().session, revision: 1, clientId: "a", name: "Клиент A", ...overrides } }; }
function child(current = () => ({ id: "a", name: "Клиент A" })) {
  const messages = [], listeners = new Set();
  const parent = { postMessage: (data, target) => messages.push({ data, target }) };
  const host = { parent, addEventListener: (_name, callback) => listeners.add(callback), removeEventListener: (_name, callback) => listeners.delete(callback) };
  const channel = connectCoreClientSelection(host, current);
  return { host, parent, channel, messages, receive(data, source = parent, origin = "null") { for (const callback of listeners) callback({ data, source, origin }); }, listeners };
}

test("panel selection: exact frame/origin/session/type/version are required", () => {
  const state = session();
  for (const invalid of [{ ...event(state), source: {} }, { ...event(state), origin: "http://127.0.0.1:3100" }, event(state, { session: "old" }), event(state, { type: "other" }), event(state, { version: 2 })]) assert.equal(state.accept(invalid, source, origin), null);
  assert.deepEqual(state.accept(event(state), source, origin), { id: "a", name: "Клиент A" });
});
test("panel selection: first expected client blocks the old document, then internal switches are allowed", () => {
  const state = session("b");
  assert.equal(state.accept(event(state, { revision: 20 }), source, origin), null);
  assert.equal(state.accept(event(state, { clientId: "b", revision: 1 }), source, origin).id, "b");
  assert.equal(state.accept(event(state, { clientId: "c", revision: 2 }), source, origin).id, "c");
});
test("panel selection: duplicate and out-of-order revisions cannot replace a newer selection", () => {
  const state = session(); state.accept(event(state, { revision: 2 }), source, origin);
  for (const revision of [0, 1, 2, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(state.accept(event(state, { revision }), source, origin), null);
  assert.equal(state.accept(event(state, { revision: 3 }), source, origin).id, "a");
});
test("panel selection: invalid or oversized public fields are rejected without consuming the revision", () => {
  const state = session();
  for (const invalid of [{ clientId: "../a" }, { clientId: "x".repeat(129) }, { name: "" }, { name: "x".repeat(1001) }, { name: "bad\nname" }]) assert.equal(state.accept(event(state, invalid), source, origin), null);
  assert.equal(state.accept(event(state), source, origin).id, "a");
});
test("panel selection: invalidation and new generation reject messages from the previous document", () => {
  const state = session(), old = event(state), generation = state.envelope().generation;
  state.invalidate(); assert.equal(state.envelope(), null); assert.equal(state.accept(old, source, origin), null);
  state.begin("a"); assert.ok(state.envelope().generation > generation); assert.equal(state.accept(old, source, origin), null);
});
test("panel selection: default empty client permits the panel's first valid selection", () => {
  const state = session(""); assert.equal(state.accept(event(state, { clientId: "b" }), source, origin).id, "b");
});
test("panel selection: browser UMD needs no Node and rejects invalid nonce factories", () => {
  const browser = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/panel-selection.js"), "utf8"), browser);
  assert.equal(typeof browser.corePanelSelection.createPanelSelectionSession, "function");
  const state = createPanelSelectionSession(() => "bad nonce"); assert.throws(() => state.begin("a"), /Invalid/); assert.equal(state.envelope(), null);
});
test("panel selection child: standalone mode has no messages or event listeners", () => {
  let calls = 0; const host = { addEventListener() { calls++; }, postMessage() { calls++; } }; host.parent = host;
  const channel = connectCoreClientSelection(host, () => null); channel.publish(); channel.close(); assert.equal(calls, 0);
});
test("panel selection child: no selection is sent until a trusted file parent provides context", () => {
  const target = child(), state = session();
  assert.equal(target.messages.length, 1); assert.equal(target.messages[0].data.type, "lms-core:client-context-ready");
  target.channel.publish(); target.receive(state.envelope(), {}, "null"); target.receive(state.envelope(), target.parent, origin);
  assert.equal(target.messages.length, 1); target.receive(state.envelope()); assert.equal(target.messages.length, 2);
});
test("panel selection child: unchanged snapshots coalesce while client changes increment revision", () => {
  let current = { id: "a", name: "Клиент A" }; const target = child(() => current), state = session();
  target.receive(state.envelope()); target.receive(state.envelope()); target.channel.publish(); assert.equal(target.messages.length, 2);
  current = { id: "b", name: "Клиент B" }; target.channel.publish();
  assert.equal(target.messages[2].data.revision, 2); assert.equal(target.messages[2].data.clientId, "b");
});
test("panel selection child: older context generations cannot reset a newer session", () => {
  const target = child(), state = session(), old = state.envelope(); target.receive(old);
  state.begin("a"); target.receive(state.envelope()); const count = target.messages.length;
  target.receive(old); target.receive({ ...state.envelope(), session: "same-generation-impostor" });
  assert.equal(target.messages.length, count); assert.equal(target.messages.at(-1).data.session, state.envelope().session);
});
test("panel selection child: absent/error client is silent and cleanup stops reads and messages", () => {
  let current = null, reads = 0; const target = child(() => { reads++; return current; }), state = session();
  target.receive(state.envelope()); assert.equal(target.messages.length, 1);
  current = { id: "a", name: "Клиент A" }; target.channel.publish(); assert.equal(target.messages.length, 2);
  target.channel.close(); const before = reads; target.channel.publish(); target.receive(state.envelope()); assert.equal(reads, before); assert.equal(target.listeners.size, 0);
});
test("panel selection child: failed parent post does not break the panel", () => {
  const target = child(); target.parent.postMessage = () => { throw new Error("closed"); };
  target.receive(session().envelope()); target.channel.close();
});
test("panel selection: real parent/child protocol roundtrip preserves client and revision boundaries", () => {
  let current = { id: "a", name: "Клиент A" }; const target = child(() => current), state = session();
  target.receive(state.envelope());
  const receive = () => state.accept({ source, origin, data: target.messages.at(-1).data }, source, origin);
  assert.equal(receive().id, "a"); current = { id: "b", name: "Клиент B" }; target.channel.publish(); assert.equal(receive().id, "b"); assert.equal(receive(), null);
});

test("panel state: exact request, session, source and origin are required", () => {
  const state = session();
  const message = { source, origin, data: { type: "lms-core:panel-state", version: 1, session: state.envelope().session, requestId: "request-a", clientId: "a", dirty: true, busy: false, blocked: false } };
  assert.equal(state.acceptState(message, {}, origin, "request-a"), null);
  assert.equal(state.acceptState(message, source, "http://127.0.0.1:3100", "request-a"), null);
  assert.equal(state.acceptState(message, source, origin, "request-b"), null);
  assert.deepEqual(state.acceptState(message, source, origin, "request-a"), { clientId: "a", dirty: true, busy: false, blocked: false });
  state.begin("a"); assert.equal(state.acceptState(message, source, origin, "request-a"), null);
});
test("panel state: malformed booleans and client fields cannot authorize navigation", () => {
  const state = session(""), data = { type: "lms-core:panel-state", version: 1, session: state.envelope().session, requestId: "r", clientId: null, dirty: false, busy: false, blocked: false };
  for (const invalid of [{ dirty: "false" }, { busy: null }, { blocked: undefined }, { clientId: "../bad" }, { version: 2 }]) assert.equal(state.acceptState({ source, origin, data: { ...data, ...invalid } }, source, origin, "r"), null);
  assert.equal(state.acceptState({ source, origin, data }, source, origin, "r").dirty, false);
  assert.equal(state.accept(event(state), source, origin).id, "a", "State requests do not consume selection revisions");
});
test("panel state: an old document cannot authorize leaving before the expected client loads", () => {
  const state = session("b"), data = { type: "lms-core:panel-state", version: 1, session: state.envelope().session, requestId: "r", clientId: "a", dirty: false, busy: false, blocked: false };
  assert.equal(state.acceptState({ source, origin, data }, source, origin, "r"), null);
  assert.equal(state.acceptState({ source, origin, data: { ...data, blocked: true } }, source, origin, "r").blocked, true);
  state.accept(event(state, { clientId: "b" }), source, origin);
  assert.equal(state.acceptState({ source, origin, data: { ...data, clientId: "b" } }, source, origin, "r").dirty, false);
});
test("panel state child: only the current parent session can request a fresh snapshot", () => {
  const target = child(), state = session();
  const request = { type: "lms-core:panel-state-request", version: 1, session: state.envelope().session, requestId: "r" };
  target.receive(request); assert.equal(target.messages.length, 1);
  target.receive(state.envelope()); const count = target.messages.length;
  target.receive({ ...request, session: "old" }); target.receive(request, {}); target.receive(request, target.parent, origin); target.receive({ ...request, requestId: "bad request" });
  assert.equal(target.messages.length, count);
  target.receive(request); assert.equal(target.messages.at(-1).data.type, "lms-core:panel-state");
});
test("panel state child: dirty and busy snapshots are read afresh, not cached", () => {
  const target = child(), state = session(); let dirty = true, busy = false;
  target.channel.close();
  const channel = connectCoreClientSelection(target.host, () => null, () => ({ dirty, busy, blocked: false }));
  target.receive(state.envelope());
  const request = { type: "lms-core:panel-state-request", version: 1, session: state.envelope().session, requestId: "r" };
  target.receive(request); assert.equal(target.messages.at(-1).data.dirty, true); assert.equal(target.messages.at(-1).data.clientId, null);
  dirty = false; busy = true; target.receive(request); assert.equal(target.messages.at(-1).data.dirty, false); assert.equal(target.messages.at(-1).data.busy, true);
  channel.close();
});
test("panel state child: snapshot failure is a safe blocked reply without private error text", () => {
  const target = child(), state = session(); target.channel.close();
  const channel = connectCoreClientSelection(target.host, () => null, () => { throw new Error("private fixture detail"); });
  target.receive(state.envelope()); target.receive({ type: "lms-core:panel-state-request", version: 1, session: state.envelope().session, requestId: "r" });
  assert.equal(target.messages.at(-1).data.blocked, true); assert.equal(JSON.stringify(target.messages).includes("private fixture"), false); channel.close();
});
test("panel state child: cleanup stops snapshot reads and replies", () => {
  const target = child(), state = session(); target.receive(state.envelope()); target.channel.close();
  const count = target.messages.length; target.receive({ type: "lms-core:panel-state-request", version: 1, session: state.envelope().session, requestId: "r" });
  assert.equal(target.messages.length, count);
});
