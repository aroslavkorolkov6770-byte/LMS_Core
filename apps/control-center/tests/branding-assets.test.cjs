const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { root, apiRequire } = require("./runtime-test-helper.cjs");
const images = require("../../../infra/scripts/client-brand-assets.cjs");
const { ClientDesignService } = require("../dist/client-design.js");
const contract = require("../../../infra/scripts/client-design-contract.cjs");
const shared = require("../../../packages/shared/dist/index.js");
const { fixtureImage: image } = require("./branding-image-fixture.cjs");
test("Linux fixture key cleanup is valid transported JavaScript and preserves every other key", () => {
  const vm = require("node:vm"), { fixtureKeyRemovalScript } = require("../../../infra/testing/linux/design-test-cleanup.cjs");
  const key = "ssh-ed25519 AAAA fixture-owned", other = "ssh-ed25519 BBBB keep-this-key";
  const source = fixtureKeyRemovalScript(key + String.fromCharCode(10));
  let written;
  new vm.Script(source).runInNewContext({ require: (name) => { assert.equal(name, "node:fs"); return { readFileSync: () => [other, key, ""].join(String.fromCharCode(10)), writeFileSync: (file, value, options) => { assert.equal(file, "/root/.ssh/authorized_keys"); assert.equal(options.mode, 0o600); written = value; } }; } });
  assert.equal(written, other + String.fromCharCode(10));
  assert.throws(() => fixtureKeyRemovalScript("-----BEGIN PRIVATE KEY-----"));
});
test("branding upload origin matches real loopback Host, not an internal Next URL", async () => {
  const ts = apiRequire("typescript"), vm = require("node:vm"), exports = {};
  const code = await fs.readFile(path.join(root, "apps/lms-web/app/lib/branding-upload-request.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, URL, Headers });
  const check = (origin, host, site) => exports.trustedBrandingUpload(new Headers({ ...(origin ? { origin } : {}), host, ...(site ? { "sec-fetch-site": site } : {}) }));
  assert.equal(check("http://127.0.0.1:3100", "127.0.0.1:3100", "same-origin"), true);
  assert.equal(check("http://localhost:3100", "localhost:3100", "same-origin"), true);
  assert.equal(check("http://127.0.0.1:3100", "localhost:3100", "same-origin"), false);
  assert.equal(check("https://evil.invalid", "evil.invalid", "same-origin"), false);
  assert.equal(check("http://127.0.0.1:3100", "127.0.0.1:3100", "cross-site"), false);
  assert.equal(check(null, "127.0.0.1:3100", "same-origin"), false);
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-brand-assets-"));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith("core-brand-assets-")); await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
  await fs.mkdir(path.join(directory, "infra/scripts"), { recursive: true });
  for (const file of ["client-design-contract.cjs", "client-brand-assets.cjs"]) await fs.copyFile(path.join(root, "infra/scripts", file), path.join(directory, "infra/scripts", file));
  return directory;
}
test("branding images: content addressed, bounded raster files and client-isolated references", async (t) => {
  const directory = await fixture(t), id = randomUUID(), other = randomUUID(), bytes = await image();
  const a = await images.storeImage(directory, id, bytes), b = await images.storeImage(directory, id, bytes);
  assert.equal(a.url, b.url); assert.equal(a.mime, "image/png"); assert.equal(a.width, 64);
  assert.deepEqual((await images.readImage(directory, id, a.asset)).bytes, bytes);
  assert.throws(() => images.parseAssetUrl(a.url, other));
  await assert.rejects(images.readImage(directory, other, a.asset));
  for (const value of ["file:///C:/private.png", "http://127.0.0.1/secrets", "https://example.invalid/logo.png", "data:image/png;base64,AAAA", "../../secret"]) assert.throws(() => images.parseAssetUrl(value, id));
  assert.throws(() => images.inspectImage(Buffer.from("<svg><script>fixture</script></svg>")));
  assert.throws(() => images.inspectImage(Buffer.alloc(images.MAX_IMAGE_BYTES + 1)));
  const huge = Buffer.from(bytes); huge.writeUInt32BE(9000, 16); assert.throws(() => images.inspectImage(huge));
  await fs.writeFile(path.join(directory, "infra/runtime/client-brand-assets", id, a.asset), await image("#a44327"));
  await assert.rejects(images.readImage(directory, id, a.asset), /BRANDING_IMAGE_CHANGED/);
});
test("client design v2: captures immutable image bytes and all saved options; v1 remains readable", async (t) => {
  const directory = await fixture(t), id = randomUUID(), settings = structuredClone(shared.mergeClientPreviewSettings({}));
  const uploaded = await images.storeImage(directory, id, await image()); settings.content.homeBackgroundImageUrl = uploaded.url;
  settings.layout.density = "compact"; settings.components.buttonShadow = false;
  settings.elementOverrides["home.title"] = { ...shared.DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE, offsetX: 17, textColor: "#123456" };
  const service = new ClientDesignService(directory, async () => ({ client: { id, name: "Fixture", brandName: "Fixture" } }), async () => ({ clientId: id, source: "saved", settings }));
  const captured = await service.capture(id), doc = await service.read(captured);
  assert.equal(captured.version, 2); assert.equal(doc.assets.length, 1); assert.equal(doc.layout.density, "compact");
  assert.equal(doc.elementOverrides["home.title"].offsetX, 17); assert.equal(doc.content.homeBackgroundImageUrl, `/core-branding/${uploaded.asset}`);
  await fs.unlink(path.join(directory, "infra/runtime/client-brand-assets", id, uploaded.asset));
  assert.deepEqual(await service.read(captured), doc, "The snapshot keeps its own verified file, not an absolute source path");
  const asset = path.join(directory, "infra/runtime/client-designs", captured.id, "assets", uploaded.asset);
  await fs.writeFile(asset, Buffer.from("changed")); await assert.rejects(service.read(captured), /Снимок оформления/);
  const legacy = contract.createClientDesign({ version: 1, clientId: id, brandName: "Legacy", settings });
  assert.equal(contract.validateClientDesign(legacy).version, 1); assert.equal(legacy.assets, undefined);
});
test("client design v2: layout/element/image descriptor corruption changes digest or is rejected", () => {
  const settings = structuredClone(shared.mergeClientPreviewSettings({})), input = { clientId: randomUUID(), brandName: "Fixture", settings };
  const a = contract.createClientDesign(input); settings.layout.cardRadiusPx = 22;
  assert.notEqual(contract.designHash(a), contract.designHash(contract.createClientDesign(input)));
  for (const change of [(s) => { s.layout.homeSectionOrder = ["hero", "hero"]; }, (s) => { s.components.smoothTabs = "yes"; }, (s) => { s.elementOverrides['x"]{}'] = {}; }, (s) => { s.elementOverrides["home.title"] = { ...shared.DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE, backgroundColor: "red;display:none" }; }]) {
    const s = structuredClone(shared.mergeClientPreviewSettings({})); change(s); assert.throws(() => contract.createClientDesign({ ...input, settings: s }));
  }
  assert.throws(() => contract.createClientDesign({ ...input, imageUrl: "https://external.invalid/image.png" }));
  assert.throws(() => contract.createClientDesign({ ...input, assets: [{ path: "../secret", bytes: 40, mime: "image/png", sha256: "a".repeat(64) }] }));
});
test("real Nest binary upload/download routes preserve bytes and reject invalid input", async (t) => {
  const directory = await fixture(t), id = randomUUID(), data = await image();
  const { BrandingAssetsController } = require("../../api/dist/modules/deploy-panel/branding-assets.controller.js");
  const { DeployPanelService } = require("../../api/dist/modules/deploy-panel/deploy-panel.service.js");
  const { Test } = apiRequire("@nestjs/testing");
  const module = await Test.createTestingModule({ controllers: [BrandingAssetsController], providers: [{ provide: DeployPanelService, useValue: {
    saveBrandingImage: (clientId, bytes) => images.storeImage(directory, clientId, bytes), readBrandingImage: (clientId, file) => images.readImage(directory, clientId, file)
  } }] }).compile();
  const app = module.createNestApplication({ logger: false }); app.setGlobalPrefix("api"); await app.listen(0, "127.0.0.1"); t.after(() => app.close());
  const origin = await app.getUrl();
  const response = await fetch(`${origin}/api/deploy-panel/branding-assets?clientId=${id}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: data });
  assert.equal(response.status, 201); const uploaded = await response.json();
  const download = await fetch(`${origin}/api/deploy-panel/branding-assets?clientId=${id}&asset=${uploaded.asset}`);
  assert.equal(download.status, 200); assert.equal(download.headers.get("content-type"), "image/png"); assert.deepEqual(Buffer.from(await download.arrayBuffer()), data);
  assert.equal((await fetch(`${origin}/api/deploy-panel/branding-assets?clientId=${randomUUID()}&asset=${uploaded.asset}`)).status, 404);
  assert.equal((await fetch(`${origin}/api/deploy-panel/branding-assets?clientId=${id}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "<svg>bad</svg>" })).status, 400);
});
