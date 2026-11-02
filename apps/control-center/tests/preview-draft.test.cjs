const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../..");
const ts = createRequire(path.join(root, "apps/control-center/package.json"))("typescript");
const shared = require(path.join(root, "packages/shared/dist/index.js"));

function loadStore() {
  const directory = path.join(root, "apps/lms-web/app/lib");
  const cache = new Map();
  function load(name) {
    const file = path.resolve(directory, `${name}.ts`);
    assert.equal(path.dirname(file), directory);
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    vm.runInNewContext(compiled.outputText, {
      exports, URL, URLSearchParams, process: { env: {} }, require: (specifier) => {
        if (specifier === "@lms-core/shared") return shared;
        if (["./preview-runtime", "./industry-options"].includes(specifier)) return load(specifier.slice(2));
        throw new Error("Unexpected import in owned preview store");
      }
    }, { filename: file });
    return exports;
  }
  return load("preview-draft-store");
}

const payload = (revision = 1, clientId = "fixture-client") => ({ clientId, revision, brandName: "Fixture brand", tariff: "extended", industryTemplate: "coffee_shop", settings: structuredClone(shared.mergeClientPreviewSettings({ content: { homeTitle: "Draft title" }, theme: { primary: "#3478c2" } })) });
const query = (client = "fixture-client", editable = true) => new URLSearchParams({ previewClientId: client, previewEditable: editable ? "1" : "0", previewHomeTitle: "Initial title" });

test("live preview: public design updates have a stable cached snapshot and notify subscribers", () => {
  const store = loadStore();
  let notified = 0;
  const unsubscribe = store.subscribePreviewDraft(() => notified++);
  assert.equal(store.getPreviewDraftVersion(), 0);
  assert.equal(store.receivePreviewDraft(payload(), "fixture-client"), true);
  const config = store.getLivePreviewRuntime(query());
  assert.equal(config.design.content.homeTitle, "Draft title");
  assert.equal(config.palette.primary, "#3478c2");
  assert.equal(config.features.aiAssistant, true);
  assert.equal(config, store.getLivePreviewRuntime(query()));
  assert.equal(notified, 1);
  unsubscribe();
  store.receivePreviewDraft(payload(2), "fixture-client");
  assert.equal(notified, 1);
});

test("live preview: initial hydration uses URL settings even if a message has arrived", () => {
  const store = loadStore();
  store.receivePreviewDraft(payload(), "fixture-client");
  const initial = store.getLivePreviewRuntime(query(), store.getServerPreviewDraftVersion());
  assert.equal(initial.design.content.homeTitle, "Initial title");
  assert.equal(store.getLivePreviewRuntime(query(), store.getPreviewDraftVersion()).design.content.homeTitle, "Draft title");
});

test("live preview: a draft cannot change ordinary LMS, read-only preview, or another client", () => {
  const store = loadStore();
  store.receivePreviewDraft(payload(), "fixture-client");
  assert.equal(store.getLivePreviewRuntime(query("other-client")).design.content.homeTitle, "Initial title");
  assert.equal(store.getLivePreviewRuntime(query("fixture-client", false)).design.content.homeTitle, "Initial title");
  assert.equal(store.getLivePreviewRuntime(new URLSearchParams()).enabled, false);
  assert.equal(store.getPreviewDraft("other-client"), null);
});

test("live preview: stale revisions are ignored and incoming objects cannot mutate stored settings", () => {
  const store = loadStore();
  const incoming = payload(5);
  store.receivePreviewDraft(incoming, "fixture-client");
  incoming.settings.theme.primary = "#000000";
  const version = store.getPreviewDraftVersion();
  assert.equal(store.receivePreviewDraft(payload(4), "fixture-client"), false);
  assert.equal(store.receivePreviewDraft(payload(5), "fixture-client"), false);
  assert.equal(store.getPreviewDraftVersion(), version);
  assert.equal(store.getPreviewDraft("fixture-client").settings.theme.primary, "#3478c2");
});

test("live preview: unknown fields are removed and malformed or oversized designs are rejected", () => {
  const store = loadStore();
  const unknown = payload(); unknown.password = "not-for-frame"; unknown.settings.theme.apiSecret = "not-for-frame";
  const clean = store.normalizePreviewDraft(unknown);
  assert.equal(JSON.stringify(clean).includes("not-for-frame"), false);
  for (const value of [null, [], { ...payload(), revision: NaN }, { ...payload(), revision: -1 }, { ...payload(), settings: null }, { ...payload(), clientId: "" }]) assert.equal(store.normalizePreviewDraft(value), null);
  const wrongTheme = payload(); wrongTheme.settings.theme.primary = 42;
  assert.equal(store.normalizePreviewDraft(wrongTheme), null);
  const wrongFont = payload(); wrongFont.settings.typography.headingScale = Infinity;
  assert.equal(store.normalizePreviewDraft(wrongFont), null);
  const tooLarge = payload(); tooLarge.settings.content.homeTitle = "x".repeat(600000);
  assert.equal(store.normalizePreviewDraft(tooLarge), null);
  const cyclic = payload(); cyclic.circular = cyclic;
  assert.equal(store.normalizePreviewDraft(cyclic), null);
});

function frame() {
  const messages = [], handlers = new Set();
  const parent = { postMessage: (message, origin) => messages.push({ message, origin }) };
  const host = { parent, location: { origin: "http://127.0.0.1:3100" }, addEventListener: (_name, handler) => handlers.add(handler), removeEventListener: (_name, handler) => handlers.delete(handler) };
  const dispatch = (data, origin = host.location.origin, source = parent) => handlers.forEach((handler) => handler({ data, origin, source }));
  return { host, parent, messages, dispatch };
}

test("live preview: bridge binds the exact parent, origin, client and protocol version", () => {
  const store = loadStore(), testFrame = frame();
  let ready = 0;
  const close = store.connectPreviewDrafts(testFrame.host, "fixture-client", () => ready++);
  const message = { ...payload(), source: store.PREVIEW_EDITOR_SOURCE, type: "apply-draft", version: 1 };
  testFrame.dispatch(message, "https://foreign.invalid");
  testFrame.dispatch(message, undefined, {});
  testFrame.dispatch({ ...message, clientId: "other-client" });
  testFrame.dispatch({ ...message, version: 2 });
  assert.equal(store.getPreviewDraftVersion(), 0);
  testFrame.dispatch(message);
  assert.equal(store.getPreviewDraftVersion(), 1);
  assert.equal(testFrame.messages[0].message.type, "draft-applied");
  assert.equal(testFrame.messages[0].origin, testFrame.host.location.origin);
  testFrame.dispatch({ ...message, type: "request-ready" });
  assert.equal(ready, 1);
  testFrame.dispatch({ ...message, revision: 0 });
  assert.equal(testFrame.messages.length, 1);
  close();
  assert.equal(store.getPreviewDraft("fixture-client"), null);
  testFrame.dispatch({ ...message, revision: 5 });
  assert.equal(store.getPreviewDraft("fixture-client"), null);
});

test("live preview: invalid current messages are rejected visibly without replacing a good draft", () => {
  const store = loadStore(), testFrame = frame();
  const close = store.connectPreviewDrafts(testFrame.host, "fixture-client", () => {});
  const message = { ...payload(), source: store.PREVIEW_EDITOR_SOURCE, type: "apply-draft", version: 1 };
  testFrame.dispatch(message);
  testFrame.dispatch({ ...message, revision: 2, settings: null });
  assert.equal(testFrame.messages.at(-1).message.type, "draft-rejected");
  assert.equal(store.getPreviewDraft("fixture-client").revision, 1);
  close();
});

test("live preview: standalone pages do not accept a fake parent channel", () => {
  const store = loadStore(), testFrame = frame();
  testFrame.host.parent = testFrame.host;
  const close = store.connectPreviewDrafts(testFrame.host, "fixture-client", () => {});
  testFrame.dispatch({ ...payload(), source: store.PREVIEW_EDITOR_SOURCE, type: "apply-draft", version: 1 }, undefined, testFrame.host);
  assert.equal(store.getPreviewDraftVersion(), 0);
  close();
});

test("live preview: URL cache is bounded and clearing a client restores its URL design", () => {
  const store = loadStore();
  const firstQuery = query();
  const first = store.getLivePreviewRuntime(firstQuery);
  for (let index = 0; index < 12; index++) store.getLivePreviewRuntime(new URLSearchParams({ previewClientId: `client-${index}` }));
  assert.notEqual(store.getLivePreviewRuntime(firstQuery), first);
  store.receivePreviewDraft(payload(), "fixture-client");
  store.clearPreviewDraft("other-client");
  assert.equal(store.getPreviewDraft("fixture-client").revision, 1);
  store.clearPreviewDraft("fixture-client");
  assert.equal(store.getLivePreviewRuntime(firstQuery).design.content.homeTitle, "Initial title");
});
