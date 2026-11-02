const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../..");
const ts = createRequire(path.join(root, "apps/control-center/package.json"))("typescript");
const shared = require(path.join(root, "packages/shared/dist/index.js"));

function load(relative, extras = {}) {
  const file = path.join(root, "apps/lms-web/app", relative), exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  vm.runInNewContext(compiled.outputText, {
    exports, URL, URLSearchParams, process: { env: {} },
    require: (specifier) => {
      if (specifier === "@lms-core/shared") return shared;
      if (specifier === "./industry-options") return load("lib/industry-options.ts");
      if (extras.require) return extras.require(specifier);
      throw new Error("Unexpected import in owned client-site test");
    }, ...Object.fromEntries(Object.entries(extras).filter(([key]) => key !== "require"))
  }, { filename: file });
  return exports;
}

test("saved site: routing URL is short regardless of the saved text or company name", () => {
  const { buildClientSiteFrameUrl } = load("lib/client-site-design.ts");
  const href = buildClientSiteFrameUrl({ clientId: "fixture", brandName: "x".repeat(20000), tariff: "extended", industryTemplate: "coffee_shop", settings: { content: { homeSubtitle: "y".repeat(20000) } } });
  assert.ok(href.length < 250);
  const params = new URL(href, "http://localhost").searchParams;
  assert.equal(params.get("previewReadonly"), "1");
  assert.equal(params.get("previewEditable"), "1", "This routing fix does not silently rewrite the existing local-preview role behavior");
  assert.equal(params.get("previewHomeSubtitle"), null);
  assert.equal(params.get("previewBrandName"), null);
});

test("saved site: internal repair retains page/hash but drops stale large preview parameters", () => {
  const { buildClientSiteFrameUrl } = load("lib/client-site-design.ts");
  const href = buildClientSiteFrameUrl({ clientId: "fixture", brandName: "Fixture", tariff: "base", industryTemplate: "coffee_shop" }, `/tasks?tab=edu&previewHomeTitle=${"x".repeat(20000)}&previewClientId=wrong#lesson`);
  const url = new URL(href, "http://localhost");
  assert.equal(url.pathname, "/tasks"); assert.equal(url.hash, "#lesson"); assert.equal(url.searchParams.get("tab"), "edu");
  assert.equal(url.searchParams.get("previewClientId"), "fixture"); assert.equal(url.searchParams.get("previewHomeTitle"), null);
  assert.throws(() => buildClientSiteFrameUrl({}, "https://another-host/"));
  assert.throws(() => buildClientSiteFrameUrl({}, "//another-host/"));
});

test("saved site: navigation propagates read-only editor controls without changing tariffs", () => {
  const runtime = load("lib/preview-runtime.ts");
  const params = new URLSearchParams({ previewClientId: "fixture", previewReadonly: "1", previewEditable: "1", previewTariff: "base", previewIndustryTemplate: "coffee_shop" });
  const href = runtime.appendPreviewParams("/profile", params), next = new URL(href, "http://localhost");
  assert.equal(next.searchParams.get("previewReadonly"), "1");
  assert.equal(runtime.readPreviewRuntime(next.searchParams).features.aiAssistant, false);
  assert.equal(runtime.readPreviewRuntime(next.searchParams).editable, true);
});

test("saved site: design receiver installs no editor styles, DOM handlers, or localStorage controls", () => {
  const frames = new Map(), messages = [];
  let effectCleanup, disconnected = 0, connected = 0, sequence = 0;
  const host = {
    location: { origin: "http://localhost", search: "?previewClientId=fixture&previewEditable=1&previewReadonly=1" },
    parent: { postMessage: (message) => messages.push(message) },
    requestAnimationFrame: (callback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id) => frames.delete(id),
    get localStorage() { throw new Error("Read-only site must not touch editor storage"); }
  };
  const bridge = load("components/PreviewRuntimeBridge.tsx", {
    window: host, document: { createElement: () => { throw new Error("Read-only site must not create editor DOM"); } },
    require: (specifier) => {
      if (specifier === "react") return { useEffect: (effect) => { effectCleanup = effect(); } };
      if (specifier === "../lib/preview-draft-store") return { connectPreviewDrafts: (window, clientId) => { assert.equal(window, host); assert.equal(clientId, "fixture"); connected++; return () => disconnected++; } };
      if (specifier === "../lib/preview-controls") return { connectPreviewControls: () => { throw new Error("Read-only site must not connect editor controls"); }, DEFAULT_PREVIEW_CONTROL: {} };
      throw new Error("Unexpected read-only bridge import");
    }
  });
  assert.equal(bridge.default(), null);
  while (frames.size) { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); }
  assert.equal(connected, 1); assert.equal(messages.length, 1); assert.equal(messages[0].type, "frame-ready");
  effectCleanup(); assert.equal(disconnected, 1);
});
