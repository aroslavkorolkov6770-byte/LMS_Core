const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../../..");
const ts = createRequire(path.join(root, "apps/control-center/package.json"))("typescript");

function load(fetch) {
  const file = path.join(root, "apps/lms-web/app/lib/preview-request.ts");
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {}, timers = new Set();
  vm.runInNewContext(compiled.outputText, {
    exports, fetch, AbortController,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); }
  }, { filename: file });
  return { ...exports, timers };
}

test("preview requests: JSON success and HTTP failures always clear the timeout", async () => {
  let calls = 0;
  const api = load(async (_url, init) => { assert.equal(init.cache, "no-store"); calls++; return calls === 1 ? { ok: true, json: async () => ({ saved: true }) } : { ok: false, status: 503 }; });
  assert.equal((await api.requestPreviewJson("/fixture")).saved, true);
  await assert.rejects(api.requestPreviewJson("/fixture"), (error) => error.kind === "http" && error.status === 503);
  assert.equal(api.timers.size, 0);
});

test("preview requests: timeout covers the body, not just receiving headers", async () => {
  const api = load(async (_url, init) => ({ ok: true, json: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true })) }));
  await assert.rejects(api.requestPreviewJson("/fixture", {}, 15), (error) => error.kind === "timeout");
  assert.equal(api.timers.size, 0);
});

test("preview requests: cancellation removes its listener and skips an already aborted fetch", async () => {
  const controller = new AbortController();
  let adds = 0, removes = 0, calls = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { adds++; return originalAdd(...args); };
  controller.signal.removeEventListener = (...args) => { removes++; return originalRemove(...args); };
  const api = load((_url, init) => { calls++; return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true })); });
  const pending = api.requestPreviewJson("/fixture", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.kind === "aborted");
  await assert.rejects(api.requestPreviewJson("/fixture", { signal: controller.signal }), (error) => error.kind === "aborted");
  assert.equal(calls, 1);
  assert.equal(adds, 1);
  assert.equal(removes, 2);
  assert.equal(api.timers.size, 0);
});

test("preview requests: malformed and raw network failures do not expose backend messages", async () => {
  let network = false;
  const api = load(async () => { if (network) throw new Error("private-url-and-password"); return { ok: true, json: async () => { throw new Error("raw backend text"); } }; });
  await assert.rejects(api.requestPreviewJson("/fixture"), (error) => error.kind === "invalid-response" && !error.message.includes("backend text"));
  network = true;
  await assert.rejects(api.requestPreviewJson("/fixture"), (error) => error.kind === "network" && !error.message.includes("password"));
  assert.equal(api.timers.size, 0);
});

test("preview requests: uncertain writes are never described as definitely unsaved", () => {
  const api = load(async () => {});
  for (const kind of ["timeout", "network", "aborted", "invalid-response"]) {
    assert.match(api.previewSaveFailureMessage(new api.PreviewRequestError(kind)), /Подтверждение сохранения не получено/);
  }
  assert.match(api.previewSaveFailureMessage(new api.PreviewRequestError("http", 500)), /Сервер не подтвердил/);
});
