const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { LocalGitPreviewService } = require("../dist/local-git-preview.js");
const { root, apiRequire } = require("./runtime-test-helper.cjs");

test("Git preview rejects invalid identity, stale client and unaccepted sources before launching code", async () => {
  let captures = 0, packages = 0;
  const id = randomUUID(), source = { id: randomUUID(), revision: "a".repeat(40), repositoryUrl: "git@github.com:fixture/lms.git" };
  const service = new LocalGitPreviewService(root, { prepare: async () => { packages++; throw Error("Unaccepted source"); } }, { capture: async () => { captures++; return {}; } }, async () => ({ client: { id: randomUUID() } }), async () => { throw Error("Database must not be read"); });
  await assert.rejects(service.start("../client", source), /Выберите/);
  assert.equal(service.get().phase, "idle");
  await assert.rejects(service.start(id, source), /Клиент изменился/);
  assert.equal(captures, 0); assert.equal(packages, 0); assert.equal(service.get().phase, "failed");
  await assert.rejects(service.login("system"), /дождитесь/);
  const blocked = new LocalGitPreviewService(root, { prepare: async () => { throw Error("Unaccepted source"); } }, { capture: async () => ({}) }, async () => ({ client: { id, name: "Fixture", brandName: "Fixture", slug: "fixture", domain: "fixture.invalid", tariff: "base", industryTemplate: "coffee_shop" } }), async () => { throw Error("Database must not be read"); });
  await assert.rejects(blocked.start(id, source), /Unaccepted source/);
  assert.equal(blocked.get().phase, "failed");
});

test("retired legacy UI returns guidance without reading clients; settings and upload API remain outside middleware", async () => {
  const code = fs.readFileSync(path.join(root, "apps/lms-web/middleware.ts"), "utf8"), ts = apiRequire("typescript");
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  vm.runInNewContext(output, { exports: exported, require: (name) => { assert.equal(name, "next/server"); return { NextResponse: Response }; } });
  const pattern = new RegExp("^" + exported.config.matcher[0] + "$");
  for (const url of ["/", "/preview", "/client/fixture", "/tasks", "/admin", "/profile"]) {
    assert.equal(pattern.test(url), true);
    const response = exported.middleware({ nextUrl: { pathname: url } });
    assert.equal(response.status, url === "/" ? 200 : 410);
    assert.ok((await response.text()).includes("Старое превью отключено"));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const url of ["/api/health", "/api/client-brand-assets", "/api/preview-settings", "/_next/static/file.js"]) assert.equal(pattern.test(url), false);
  const panel = fs.readFileSync(path.join(root, "apps/deploy-panel/app/deploy-panel-client.tsx"), "utf8");
  assert.equal(panel.includes("/preview?"), false); assert.equal(panel.includes("/client/${"), false);
});

test("stop ignores queued ready and credential messages until owned worker confirms cleanup", async () => {
  const sourceCode = fs.readFileSync(path.join(root, "apps/control-center/src/local-git-preview.ts"), "utf8");
  const output = apiRequire("typescript").transpileModule(sourceCode, { compilerOptions: { target: apiRequire("typescript").ScriptTarget.ES2022, module: apiRequire("typescript").ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const worker = new EventEmitter(); worker.connected = true; worker.send = () => {};
  const exported = {};
  vm.runInNewContext(output, { exports: exported, require: (name) => name === "node:child_process" ? { spawn: () => worker } : require(name), URL });
  const id = randomUUID(), source = { id: randomUUID(), revision: "b".repeat(40), repositoryUrl: "git@github.com:fixture/lms.git" };
  const service = new exported.LocalGitPreviewService(root, { prepare: async (_id, design) => { assert.equal(design, undefined); return { revision: source.revision }; }, verify: async () => ({}) }, { capture: async () => { throw Error("Defaults must not restyle source UI"); } }, async () => ({ client: { id, name: "Fixture", brandName: "Fixture", slug: "fixture", domain: "fixture.invalid", tariff: "base", industryTemplate: "coffee_shop" } }), async () => "not-transmitted-to-renderer");
  await service.start(id, source);
  assert.equal(service.get().presentationMode, "source");
  worker.emit("message", { phase: "building", message: "Build" });
  const stopping = service.stop(); assert.equal(service.get().phase, "stopping");
  worker.emit("message", { phase: "ready", url: "http://127.0.0.1:23011", message: "Late ready" });
  worker.emit("message", { type: "credentials", admins: { clientAdminPassword: "never-public" } });
  assert.equal(service.get().phase, "stopping"); assert.equal(service.get().url, undefined);
  assert.equal(JSON.stringify(service.get()).includes("never-public"), false);
  worker.emit("message", { phase: "stopped", message: "Cleaned" }); worker.emit("exit", 0);
  await stopping; assert.equal(service.get().phase, "stopped");
});
