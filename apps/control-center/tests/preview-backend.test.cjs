const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../..");
const ts = createRequire(path.join(root, "apps/control-center/package.json"))("typescript");
const react = createRequire(path.join(root, "apps/lms-web/package.json"))("react/jsx-runtime");

function modules(fetch) {
  const cache = new Map();
  const shell = () => {}, unavailable = () => {}, savedView = () => {}, cleanState = () => {};
  function load(relative) {
    const file = path.join(root, "apps/lms-web/app", relative);
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
    vm.runInNewContext(compiled.outputText, {
      exports, fetch, AbortController, Headers, URL, URLSearchParams,
      process: { env: { DEPLOY_PANEL_API_URL: "http://127.0.0.1:1", DEPLOY_PANEL_DEV_USER_ID: "fixture-user", DEPLOY_PANEL_DEV_CLIENT_ID: "fixture-owner" } },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 25)), clearTimeout,
      require: (specifier) => {
        if (specifier === "react/jsx-runtime") return react;
        if (specifier === "next/server") return { NextResponse: { json: (payload, init) => ({ payload, status: init?.status ?? 200 }) } };
        if (specifier === "./preview-shell") return { PreviewShell: shell };
        if (specifier === "./client-site-view") return { ClientSiteView: savedView };
        if (specifier.endsWith("/PreviewUnavailable")) return { PreviewUnavailable: unavailable };
        if (specifier.endsWith("/CoreCleanPreviewState")) return { CoreCleanPreviewState: cleanState };
        if (specifier === "@lms-core/shared") return {};
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(file), specifier);
          return load(path.relative(path.join(root, "apps/lms-web/app"), target) + ".ts");
        }
        throw new Error("Unexpected import in owned preview backend test");
      }
    }, { filename: file });
    return exports;
  }
  return { load, shell, unavailable, savedView };
}

test("preview backend: existing local headers stay server-side and response status is preserved", async () => {
  let called = false;
  const loader = modules(async (url, init) => {
    called = true;
    assert.equal(url, "http://127.0.0.1:1/api/deploy-panel/preview-settings?clientId=fixture");
    assert.equal(init.headers.get("x-dev-role-code"), "system_admin");
    assert.equal(init.headers.get("x-dev-user-id"), "fixture-user");
    assert.equal(init.headers.get("Content-Type"), "application/json");
    return { ok: true, status: 201, json: async () => ({ saved: true }) };
  });
  const backend = loader.load("lib/preview-backend.ts");
  const result = await backend.requestPreviewBackend("/api/deploy-panel/preview-settings?clientId=fixture", { headers: { "Content-Type": "application/json" } });
  assert.equal(result.status, 201);
  assert.equal(result.payload.saved, true);
  await assert.rejects(backend.requestPreviewBackend("https://another-host/"), (error) => error.kind === "invalid-response");
  assert.equal(called, true);
});

test("preview backend: timeout and untrusted backend errors become bounded safe failures", async () => {
  const loader = modules((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("private-url")), { once: true })));
  const backend = loader.load("lib/preview-backend.ts");
  let failure;
  try { await backend.requestPreviewBackend("/api/deploy-panel/preview-settings"); } catch (error) { failure = backend.previewBackendFailure(error); }
  assert.equal(failure.status, 504);
  assert.ok(!failure.message.includes("private"));
  const request = loader.load("lib/preview-request.ts");
  assert.equal(backend.previewBackendFailure(new request.PreviewRequestError("invalid-response")).status, 502);
  assert.equal(backend.previewBackendFailure(new Error("secret")).status, 503);
});

test("preview page: a saved-settings failure does not silently open an editor with defaults", async () => {
  const loader = modules(async (url) => url.includes("client-detail")
    ? { ok: true, status: 200, json: async () => ({ client: { id: "fixture" } }) }
    : { ok: false, status: 503 });
  const result = await loader.load("preview/page.tsx").default({ searchParams: Promise.resolve({ clientId: "fixture" }) });
  assert.equal(result.type, loader.unavailable);
  assert.equal(result.props.retryHref, "/preview?clientId=fixture");
  assert.equal(result.props.clientId, "fixture");
});

test("preview page: wrong-client envelopes are rejected before rendering the shell", async () => {
  const loader = modules(async (url) => ({ ok: true, status: 200, json: async () => url.includes("client-detail") ? { client: { id: "another-client" } } : { clientId: "fixture", settings: {} } }));
  const result = await loader.load("preview/page.tsx").default({ searchParams: Promise.resolve({ clientId: "fixture" }) });
  assert.equal(result.type, loader.unavailable);
});

test("preview proxy: invalid input is not forwarded and nested settings preserve compatibility", async () => {
  let forwarded;
  const loader = modules(async (_url, init) => { forwarded = JSON.parse(init.body); return { ok: true, status: 201, json: async () => ({ settings: forwarded }) }; });
  const route = loader.load("api/preview-settings/route.ts");
  assert.equal((await route.POST({ json: async () => [] })).status, 400);
  assert.equal(forwarded, undefined);
  const result = await route.POST({ json: async () => ({ clientId: "fixture", settings: { clientId: "must-not-override-envelope", version: 1, theme: { primary: "#123456" } } }) });
  assert.equal(result.status, 201);
  assert.equal(forwarded.clientId, "fixture");
  assert.equal(forwarded.version, undefined);
  assert.equal(forwarded.theme.primary, "#123456");
});

test("preview proxy: backend rejection and aborted requests return a safe actionable response", async () => {
  const loader = modules(async () => ({ ok: false, status: 404 }));
  const route = loader.load("api/preview-settings/route.ts");
  const result = await route.GET({ nextUrl: new URL("http://localhost/api/preview-settings?clientId=fixture%26other%3D1") });
  assert.equal(result.status, 404);
  assert.match(result.payload.message, /не найдены/);
  const controller = new AbortController(); controller.abort();
  const aborted = await route.GET({ signal: controller.signal, nextUrl: new URL("http://localhost/api/preview-settings?clientId=fixture") });
  assert.equal(aborted.status, 503);
});

test("saved-site page: large saved settings are props, not a redirect or query string", async () => {
  const longText = "Saved public text ".repeat(1400);
  const loader = modules(async (url) => ({ ok: true, status: 200, json: async () => url.includes("client-detail")
    ? { client: { id: "fixture", brandName: "Fixture", tariff: "base", industryTemplate: "coffee_shop" } }
    : { clientId: "fixture", settings: { content: { homeSubtitle: longText } } } }));
  const result = await loader.load("client/[clientId]/page.tsx").default({ params: Promise.resolve({ clientId: "fixture" }) });
  assert.equal(result.type, loader.savedView);
  assert.equal(result.props.design.settings.content.homeSubtitle, longText);
});

test("saved-site page: settings from another client cannot populate the saved view", async () => {
  const loader = modules(async (url) => ({ ok: true, status: 200, json: async () => url.includes("client-detail") ? { client: { id: "fixture" } } : { clientId: "another-client", settings: {} } }));
  const result = await loader.load("client/[clientId]/page.tsx").default({ params: Promise.resolve({ clientId: "fixture" }) });
  assert.equal(result.type, loader.unavailable);
});
