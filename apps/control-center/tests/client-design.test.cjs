const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createClientDesign, validateClientDesign, designHash } = require("../../../infra/scripts/client-design-contract.cjs");
const { patchTexts, patchLayout } = require("../../../infra/scripts/lms-presentation-adapter.cjs");
const { ClientDesignService } = require("../dist/client-design.js");
const shared = require("../../../packages/shared/dist/index.js");
const root = path.resolve(__dirname, "../../..");
const settings = () => structuredClone(shared.mergeClientPreviewSettings({}));
const fixture = () => ({ clientId: randomUUID(), brandName: "Design fixture", settings: settings() });

test("client design: canonical public snapshot and hash bind client, text, color and font", () => {
  const a = fixture(), doc = createClientDesign(a);
  assert.deepEqual(validateClientDesign(doc), doc);
  assert.match(designHash(doc), /^[a-f0-9]{64}$/);
  for (const change of [(value) => { value.clientId = randomUUID(); }, (value) => { value.settings.content.homeTitle = "Another client"; }, (value) => { value.settings.theme.primary = "#112233"; }, (value) => { value.settings.typography.bodyFont = "Georgia, serif"; }]) {
    const b = structuredClone(a); change(b); assert.notEqual(designHash(createClientDesign(b)), designHash(doc));
  }
});

test("client design: text is data; unknown secret fields are not projected", () => {
  const a = fixture(); a.settings.password = "never-in-release"; a.settings.theme.password = "never-in-release";
  a.settings.content.homeTitle = '<script>alert("fixture")</script>';
  const doc = createClientDesign(a);
  assert.equal(doc.content.homeTitle, a.settings.content.homeTitle);
  assert.equal(JSON.stringify(doc).includes("never-in-release"), false);
  assert.throws(() => validateClientDesign({ ...doc, secret: "not-accepted" }));
});

test("client design: malformed colors/fonts/numbers/version and oversized input are refused", () => {
  for (const change of [(a) => { a.settings.theme.button = "red;display:none"; }, (a) => { a.settings.theme.button = "rgba(0,0,0,)"; }, (a) => { a.settings.typography.bodyFont = '"Georgia'; }, (a) => { a.settings.typography.bodyFont = 'x</style><script>'; }, (a) => { a.settings.typography.headingScale = Infinity; }, (a) => { a.settings.version = 2; }, (a) => { a.settings.content.homeTitle = "x".repeat(20001); }, (a) => { a.clientId = "../other"; }]) {
    const a = fixture(); change(a); assert.throws(() => createClientDesign(a));
  }
});

test("presentation adapter: patches React text only, retaining auth logic and comments", () => {
  const source = '"use client";\n// Keep auth unchanged\nexport default function Login(){ const allowed = checkPassword(); return <h1>Hello</h1>; }';
  const result = patchTexts(source, "fixture.tsx", [{ kind: "jsx", text: "Hello", key: "homeTitle", minimum: 1 }]);
  assert.ok(result.source.includes("const allowed = checkPassword();"));
  assert.ok(result.source.includes("// Keep auth unchanged"));
  assert.ok(result.source.includes('coreDesign?.content["homeTitle"]'));
  assert.equal(result.source.match(/const coreDesign =/g).length, 1);
  assert.throws(() => patchTexts(source, "fixture.tsx", [{ kind: "jsx", text: "Missing", key: "homeTitle", minimum: 1 }]));
});

test("presentation adapter: unknown layout is refused rather than guessing an insertion point", () => {
  assert.throws(() => patchLayout('export default function Root(){return <html><body>Unknown layout</body></html>}'));
});

test("client design service: immutable saved snapshot, current digest and tamper/client guards", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-design-snapshot-"));
  try {
    await fs.mkdir(path.join(directory, "infra/scripts"), { recursive: true });
    for (const file of ["client-design-contract.cjs", "client-brand-assets.cjs"]) await fs.copyFile(path.join(root, "infra/scripts", file), path.join(directory, "infra/scripts", file));
    const clientId = randomUUID(); let value = settings();
    const service = new ClientDesignService(directory, async (id) => ({ client: { id, brandName: "Saved brand" } }), async (id) => ({ clientId: id, source: "saved", settings: value }));
    const captured = await service.capture(clientId);
    assert.equal((await service.read(captured)).brandName, "Saved brand");
    assert.equal(await service.currentHash(clientId), captured.sha256);
    value.content.homeTitle = "New saved text";
    assert.notEqual(await service.currentHash(clientId), captured.sha256);
    assert.notEqual((await service.read(captured)).content.homeTitle, value.content.homeTitle);
    await assert.rejects(service.read({ ...captured, clientId: randomUUID() }));
    await fs.writeFile(path.join(directory, "infra/runtime/client-designs", captured.id, "design.json"), "{}");
    await assert.rejects(service.read(captured));
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith("core-design-snapshot-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
