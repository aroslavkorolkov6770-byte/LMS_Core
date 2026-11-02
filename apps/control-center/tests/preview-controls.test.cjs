const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../..");
const ts = createRequire(path.join(root, "apps/control-center/package.json"))("typescript");

function load() {
  const file = path.join(root, "apps/lms-web/app/lib/preview-controls.ts"), exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(compiled.outputText, { exports, require: (name) => { assert.equal(name, "./preview-draft-store"); return { PREVIEW_EDITOR_SOURCE: "lms-preview-editor" }; } }, { filename: file });
  return exports;
}
function control() { return { selectMode: true, dragMode: false, selectedId: "home.title", primary: "#3478c2", accent: "#123456", buttonText: "#ffffff", textEditableIds: ["home.title"], elementOverrides: { "home.title": { offsetX: 12, offsetY: -9, unused: "ignored" } }, privateValue: "not-forwarded" }; }
function host() {
  const listeners = new Set(), frames = new Map(); let next = 0;
  const parent = {};
  return { parent, location: { origin: "http://localhost" }, listeners, frames,
    addEventListener: (type, listener) => { assert.equal(type, "message"); listeners.add(listener); }, removeEventListener: (_type, listener) => listeners.delete(listener),
    requestAnimationFrame: (callback) => { frames.set(++next, callback); return next; }, cancelAnimationFrame: (id) => frames.delete(id),
    emit(data, extra = {}) { for (const listener of listeners) listener({ data, source: parent, origin: "http://localhost", ...extra }); },
    flush() { for (const [id, callback] of frames) { frames.delete(id); callback(); } }
  };
}
const message = (revision = 1, state = control()) => ({ source: "lms-preview-editor", type: "apply-controls", version: 1, clientId: "fixture", revision, control: state });

test("preview controls: copies only bounded public controls without retaining caller objects", () => {
  const api = load(), input = control(), result = api.normalizePreviewControl(input);
  assert.equal(result.selectedId, "home.title"); assert.equal(result.privateValue, undefined); assert.equal(result.elementOverrides["home.title"].unused, undefined);
  input.textEditableIds.push("home.subtitle"); input.elementOverrides["home.title"].offsetX = 999;
  assert.equal(result.textEditableIds.length, 1); assert.equal(result.elementOverrides["home.title"].offsetX, 12);
  assert.ok(api.normalizePreviewControl({ ...control(), primary: "rgba(20,30,40,0.8)", accent: "red" }), "Existing non-hex CSS colors must not disable editing controls");
});

test("preview controls: rejects invalid IDs/colors/types/counts/oversized bodies and non-finite offsets", () => {
  const api = load();
  for (const state of [
    { ...control(), primary: "red;display:none" }, { ...control(), selectedId: 'broken"]' }, { ...control(), dragMode: 1 },
    { ...control(), textEditableIds: Array(257).fill("home.title") }, { ...control(), elementOverrides: { x: { offsetX: Infinity } } },
    { ...control(), unused: "x".repeat(128 * 1024) }
  ]) assert.equal(api.normalizePreviewControl(state), null);
});

test("preview controls: exact parent/origin/client/type/version/revision are required", () => {
  const api = load(), window = host(); let applied = 0;
  api.connectPreviewControls(window, "fixture", () => applied++);
  window.emit(message(), { source: {} }); window.emit(message(), { origin: "http://another-host" });
  for (const override of [{ clientId: "other" }, { type: "apply-draft" }, { source: "other" }, { version: 2 }, { revision: 0 }, { revision: 1.5 }]) window.emit({ ...message(), ...override });
  window.flush(); assert.equal(applied, 0);
  window.emit(message()); window.flush(); assert.equal(applied, 1);
});

test("preview controls: rapid updates coalesce into one frame and stale or malformed revisions do not win", () => {
  const api = load(), window = host(), applied = [];
  api.connectPreviewControls(window, "fixture", (state) => applied.push(state));
  for (let revision = 1; revision <= 50; revision++) window.emit(message(revision, { ...control(), selectedId: `home.item${revision}` }));
  assert.equal(window.frames.size, 1); window.flush(); assert.equal(applied.length, 1); assert.equal(applied[0].selectedId, "home.item50");
  window.emit(message(49)); window.emit(message(999, { ...control(), primary: "invalid" })); window.flush(); assert.equal(applied.length, 1);
  window.emit(message(51)); window.flush(); assert.equal(applied.length, 2); assert.equal(applied[1].selectedId, "home.title");
});

test("preview controls: cleanup cancels pending frames and removes the listener", () => {
  const api = load(), window = host(); let applied = 0;
  const disconnect = api.connectPreviewControls(window, "fixture", () => applied++);
  window.emit(message()); disconnect(); window.flush();
  assert.equal(window.listeners.size, 0); assert.equal(window.frames.size, 0); assert.equal(applied, 0);
});

test("preview controls: two frames of the same client have independent state and revisions", () => {
  const api = load(), first = host(), second = host(); let a, b;
  api.connectPreviewControls(first, "fixture", (state) => { a = state; }); api.connectPreviewControls(second, "fixture", (state) => { b = state; });
  first.emit(message(100, { ...control(), selectMode: false })); second.emit(message(1)); first.flush(); second.flush();
  assert.equal(a.selectMode, false); assert.equal(b.selectMode, true);
  first.emit(message(101, { ...control(), selectedId: "home.subtitle" })); first.flush(); assert.equal(b.selectedId, "home.title");
});

test("preview controls: standalone pages cannot impersonate an editor parent", () => {
  const api = load(), window = host(); window.parent = window; let applied = 0;
  api.connectPreviewControls(window, "fixture", () => applied++);
  window.emit(message(), { source: window }); window.flush(); assert.equal(applied, 0);
});
