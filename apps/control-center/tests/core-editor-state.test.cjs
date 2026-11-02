const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createPanelSelectionSession } = require("../renderer/panel-selection.js");
const file = path.resolve(__dirname, "../../lms-web/app/lib/core-editor-state.ts");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exportsObject });
const { connectCoreEditorState } = exportsObject;

function fixture(getState = () => ({ dirty: false, busy: false, blocked: false })) {
  const messages = [], listeners = new Set();
  const parent = { postMessage(data, origin) { messages.push({ data, origin }); } };
  const host = { parent, addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) };
  const close = connectCoreEditorState(host, "client-a", getState);
  const context = { type: "lms-core:client-context", version: 1, session: "nonce-a", generation: 1 };
  const request = { type: "lms-core:panel-state-request", version: 1, session: "nonce-a", requestId: "request-a" };
  const receive = (data, source = parent, origin = "null") => { for (const listener of listeners) listener({ data, source, origin }); };
  return { messages, listeners, parent, receive, close, context, request };
}

test("editor state: standalone editors do not create a desktop bridge", () => {
  const host = {}; host.parent = host;
  assert.doesNotThrow(() => connectCoreEditorState(host, "a", () => { throw Error("Must not read"); })());
});

test("editor state: exact file parent and active context are required", () => {
  const f = fixture();
  f.receive(f.request); f.receive(f.context, {}, "null"); f.receive(f.context, f.parent, "https://untrusted.invalid"); f.receive(f.request);
  assert.equal(f.messages.length, 1);
  f.receive(f.context); f.receive(f.request, {}, "null"); f.receive(f.request, f.parent, "https://untrusted.invalid");
  assert.equal(f.messages.length, 1);
  f.receive(f.request); assert.equal(f.messages.length, 2); assert.equal(f.messages[1].data.clientId, "client-a");
});

test("editor state: only current bounded public booleans leave the editor", () => {
  let value = { dirty: true, busy: false, blocked: false, secret: "never-forwarded" };
  const f = fixture(() => value); f.receive(f.context); f.receive(f.request);
  assert.equal(f.messages.at(-1).data.dirty, true);
  assert.equal(JSON.stringify(f.messages).includes("never-forwarded"), false);
  value = { dirty: false, busy: true, blocked: false }; f.receive({ ...f.request, requestId: "request-b" });
  assert.equal(f.messages.at(-1).data.busy, true); assert.equal(f.messages.at(-1).data.dirty, false);
});

test("editor state: older generations and stale requests cannot replace a current session", () => {
  const f = fixture(); f.receive({ ...f.context, session: "nonce-b", generation: 2 });
  f.receive(f.context); f.receive({ ...f.context, generation: 2 }); f.receive(f.request);
  assert.equal(f.messages.length, 1);
  for (const requestId of [null, 1, "x".repeat(129), "with space"]) f.receive({ ...f.request, session: "nonce-b", requestId });
  assert.equal(f.messages.length, 1);
  f.receive({ ...f.request, session: "nonce-b" }); assert.equal(f.messages.at(-1).data.session, "nonce-b");
});

test("editor state: unavailable state blocks leaving and cleanup removes the listener", () => {
  const f = fixture(() => { throw Error("Fixture unreadable draft"); }); f.receive(f.context); f.receive(f.request);
  assert.equal(f.messages.at(-1).data.blocked, true); assert.equal(f.messages.at(-1).data.dirty, true);
  f.close(); f.receive(f.request); assert.equal(f.listeners.size, 0); assert.equal(f.messages.length, 2);
});

test("editor state: malformed snapshots block leaving without exposing extra fields", () => {
  const f = fixture(() => ({ dirty: "false", busy: false, blocked: false, privateValue: "not-public" }));
  f.receive(f.context); f.receive(f.request);
  assert.equal(f.messages.at(-1).data.blocked, true);
  assert.equal(JSON.stringify(f.messages).includes("not-public"), false);
});

test("editor state: an empty non-editable page may report a clean null client", () => {
  const messages = [], listeners = new Set();
  const parent = { postMessage: (data) => messages.push(data) };
  const close = connectCoreEditorState({ parent, addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) }, null, () => ({ dirty: false, busy: false, blocked: false }));
  for (const listener of listeners) {
    listener({ source: parent, origin: "null", data: { type: "lms-core:client-context", version: 1, session: "empty-page", generation: 1 } });
    listener({ source: parent, origin: "null", data: { type: "lms-core:panel-state-request", version: 1, session: "empty-page", requestId: "empty-request" } });
  }
  assert.equal(messages.at(-1).clientId, null);
  assert.equal(messages.at(-1).dirty, false);
  assert.equal(messages.at(-1).blocked, false);
  close();
});

test("editor state: parent protocol accepts the matching client, not another client's document", () => {
  const f = fixture(), parent = createPanelSelectionSession(() => "nonce-a"); parent.begin("client-a");
  f.receive(parent.envelope()); f.receive(f.request);
  const event = { source: {}, origin: "http://127.0.0.1:3100", data: f.messages.at(-1).data };
  assert.equal(parent.acceptState(event, event.source, event.origin, "request-a").dirty, false);
  parent.begin("client-b"); f.receive(parent.envelope()); f.receive(f.request);
  event.data = f.messages.at(-1).data;
  assert.equal(parent.acceptState(event, event.source, event.origin, "request-a"), null);
});
