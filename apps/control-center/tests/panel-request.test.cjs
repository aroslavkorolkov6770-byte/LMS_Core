const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../..");
const ts = createRequire(path.join(root, "apps/control-center/package.json"))("typescript");
const jsx = createRequire(path.join(root, "apps/deploy-panel/package.json"))("react/jsx-runtime");
const PanelComponent = () => {};

function loadModules(fetch, fastTimeout = false) {
  const cache = new Map(), timers = new Set();
  function load(name) {
    const file = path.resolve(root, "apps/deploy-panel/app", name);
    assert.ok(file.startsWith(path.resolve(root, "apps/deploy-panel/app") + path.sep));
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
    vm.runInNewContext(compiled.outputText, {
      exports, fetch, Headers, URL, AbortController,
      process: { env: { DEPLOY_PANEL_API_URL: "http://127.0.0.1:1", DEPLOY_PANEL_DEV_USER_ID: "fixture-operator", DEPLOY_PANEL_DEV_CLIENT_ID: "fixture-core" } },
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, fastTimeout ? Math.min(ms, 20) : ms); timers.add(timer); return timer; },
      clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); },
      require: (specifier) => {
        if (specifier === "react/jsx-runtime") return jsx;
        if (specifier === "./deploy-panel-client") return { DeployPanelClient: PanelComponent };
        if (specifier === "next/server") return { NextResponse: { json: (payload, init) => ({ payload, status: init?.status ?? 200 }) } };
        if (specifier.startsWith(".")) return load(path.relative(path.resolve(root, "apps/deploy-panel/app"), path.resolve(path.dirname(file), `${specifier}.ts`)));
        throw new Error("Unexpected import in owned panel request test");
      }
    }, { filename: file });
    return exports;
  }
  return { load, timers };
}

test("panel: single-flight binds action/client and an old completion cannot release a new operation", () => {
  const { PanelOperationGate } = loadModules(async () => {}).load("panel-request.ts");
  const gate = new PanelOperationGate();
  const first = gate.begin("profile", "client-a");
  assert.equal(gate.begin("health", "client-a"), null);
  assert.equal(gate.isCurrent(first, "client-a"), true);
  assert.equal(gate.isCurrent(first, "client-b"), false);
  gate.cancel();
  assert.equal(first.controller.signal.aborted, true);
  const next = gate.begin("validate", "client-b");
  assert.equal(gate.finish(first), false);
  assert.equal(gate.isCurrent(next, "client-b"), true);
  assert.equal(gate.finish(next), true);
});

test("panel: JSON is parsed once within the deadline, timers are released, and writes never retry", async () => {
  let calls = 0, parses = 0;
  const loader = loadModules(async (_url, init) => { calls++; assert.equal(init.cache, "no-store"); return { ok: true, status: 201, json: async () => { parses++; return { status: "draft" }; } }; });
  const response = await loader.load("panel-request.ts").requestPanel("/fixture", { method: "POST" }, new AbortController().signal);
  await response.json(); await response.json();
  assert.equal(response.status, 201); assert.equal(calls, 1); assert.equal(parses, 1); assert.equal(loader.timers.size, 0);
});

test("panel: stalled response bodies time out and pre-aborted requests do not reach fetch", async () => {
  let calls = 0;
  const loader = loadModules(async (_url, init) => { calls++; return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("private transport")), { once: true })) }; });
  const api = loader.load("panel-request.ts");
  await assert.rejects(api.requestPanel("/fixture", {}, new AbortController().signal, 15), (error) => error.kind === "timeout");
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(api.requestPanel("/fixture", {}, cancelled.signal), (error) => error.kind === "aborted");
  assert.equal(calls, 1); assert.equal(loader.timers.size, 0);
});

test("panel: malformed success is rejected while non-JSON server failure is safe and actionable", async () => {
  let ok = true;
  const loader = loadModules(async () => ({ ok, status: ok ? 200 : 500, json: async () => { throw new Error("private server response"); } }));
  const api = loader.load("panel-request.ts");
  await assert.rejects(api.requestPanel("/fixture", {}, new AbortController().signal), (error) => error.kind === "invalid-response");
  ok = false;
  const result = await api.requestPanel("/fixture", {}, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(await result.json()).includes("private"));
});

test("panel: bounded validation details survive but raw 500 messages do not", async () => {
  let status = 400;
  const loader = loadModules(async () => ({ ok: false, status, json: async () => ({ message: ["Field is required", "a".repeat(1000)] }) }));
  const api = loader.load("panel-request.ts");
  const invalid = await (await api.requestPanel("/fixture", {}, new AbortController().signal)).json();
  assert.match(invalid.message, /Field is required/); assert.ok(invalid.message.length <= 800);
  status = 500;
  const failed = await (await api.requestPanel("/fixture", {}, new AbortController().signal)).json();
  assert.ok(!failed.message.includes("Field"));
  assert.match(api.panelRequestFailure(new api.PanelRequestError("timeout"), true), /Результат операции пока неизвестен/);
});

test("panel proxy: all eight POST routes preserve commands/status and keep control-plane identity server-side", async () => {
  const requests = [];
  const loader = loadModules(async (url, init) => { requests.push(url); assert.equal(init.headers.get("x-dev-user-id"), "fixture-operator"); assert.equal(init.headers.get("x-dev-role-code"), "system_admin"); return { ok: true, status: 201, json: async () => ({ accepted: true }) }; });
  for (const command of ["bootstrap-client", "update-deploy-profile", "mark-draft", "mark-validated", "mark-ready-to-deploy", "mark-deployed", "run-deploy", "run-health-check"]) {
    const result = await loader.load(`api/${command}/route.ts`).POST({ json: async () => ({ clientId: "fixture" }), signal: new AbortController().signal });
    assert.equal(result.status, 201); assert.equal(result.payload.accepted, true);
    assert.equal(requests.at(-1), `http://127.0.0.1:1/api/deploy-panel/${command}`);
  }
  assert.equal(loader.timers.size, 0);
});

test("panel proxy: invalid JSON/arrays and missing validation client never reach backend", async () => {
  let calls = 0;
  const loader = loadModules(async () => { calls++; });
  const post = loader.load("api/bootstrap-client/route.ts");
  assert.equal((await post.POST({ json: async () => [] })).status, 400);
  assert.equal((await post.POST({ json: async () => { throw new Error("bad JSON"); } })).status, 400);
  assert.equal((await loader.load("api/validate-client/route.ts").GET({ nextUrl: new URL("http://localhost/api/validate-client") })).status, 400);
  assert.equal(calls, 0);
});

test("panel proxy: validation encodes the selected client and bounded timeout returns 504", async () => {
  let url;
  const loader = loadModules(async (target) => { url = target; return { ok: true, status: 200, json: async () => ({ isValid: true }) }; });
  const result = await loader.load("api/validate-client/route.ts").GET({ nextUrl: new URL("http://localhost/api/validate-client?clientId=fixture%26other%3D1") });
  assert.equal(result.status, 200); assert.ok(url.endsWith("clientId=fixture%26other%3D1"));
  const stalled = loadModules((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("private-host")), { once: true })), true);
  const timeout = await stalled.load("api/update-deploy-profile/route.ts").POST({ json: async () => ({ clientId: "fixture" }), signal: new AbortController().signal });
  assert.equal(timeout.status, 504); assert.ok(!timeout.payload.message.includes("private-host")); assert.equal(stalled.timers.size, 0);
});

test("panel page: malformed or incomplete dashboard counters produce a recoverable load error", async () => {
  const loader = loadModules(async () => ({ ok: true, status: 200, json: async () => ({ summary: {}, clients: [] }) }));
  const result = await loader.load("page.tsx").default({ searchParams: Promise.resolve({}) });
  assert.equal(result.type, PanelComponent);
  assert.ok(result.props.loadError);
  assert.equal(result.props.detail, null);
});

test("panel page: a mismatched detail cannot replace the selected client", async () => {
  const dashboard = { summary: { totalClients: 1, activeClients: 1, draftCount: 1, validatedCount: 0, readyToDeployCount: 0, deployedCount: 0 }, clients: [{ id: "fixture", name: "Fixture", features: {} }] };
  const detail = { client: { id: "fixture" }, adminCredentials: {}, checklist: [], activity: [], validation: { items: [] }, health: { items: [] }, healthHistory: [], deployRun: { steps: [] } };
  let wrong = false;
  const loader = loadModules(async (url) => ({ ok: true, status: 200, json: async () => url.endsWith("dashboard") ? dashboard : { ...detail, client: { id: wrong ? "another-client" : "fixture" } } }));
  const page = loader.load("page.tsx").default;
  const healthy = await page({ searchParams: Promise.resolve({ clientId: "fixture" }) });
  assert.equal(healthy.props.loadError, null);
  assert.equal(healthy.props.detail.client.id, "fixture");
  wrong = true;
  const failed = await page({ searchParams: Promise.resolve({ clientId: "fixture" }) });
  assert.ok(failed.props.loadError);
  assert.equal(failed.props.detail, null);
});
