const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { root } = require("./runtime-test-helper.cjs");
const { emptyPointDesign, validatePointDesign, CATALOG, FONTS } = require("../../../infra/scripts/point-design-contract.cjs");
const { designHash, validateClientDesign } = require("../../../infra/scripts/client-design-contract.cjs");
const { PointDesignService, PointEditor } = require("../dist/point-design.js");
const revision = "6a91c64ba245b517b09b8321244ebade8e8957c0";
const fixture = () => emptyPointDesign(randomUUID(), revision);

test("point document contains only explicit properties, deterministic digest and bound Git revision", () => {
  const doc = fixture(); assert.deepEqual(doc.elements, {});
  doc.elements["login.submit"] = { text: "Войти в кабинет", styles: { light: { color: "#ffffff", backgroundColor: "#174d53", fontSizePx: 18, fontFamily: FONTS.humanist } } };
  const normalized = validatePointDesign(doc);
  assert.deepEqual(validateClientDesign(normalized), normalized);
  assert.equal(normalized.theme, undefined); assert.equal(normalized.typography, undefined); assert.equal(normalized.brandName, undefined);
  assert.equal(normalized.elements["login.submit"].styles.dark, undefined);
  assert.match(designHash(normalized), /^[a-f0-9]{64}$/);
  assert.notEqual(designHash(normalized), designHash({ ...normalized, sourceRevision: "a".repeat(40) }));
  assert.deepEqual(validatePointDesign({ ...doc, elements: { "login.submit": { styles: { light: {} } } } }).elements, {});
});

test("point document rejects arbitrary selector/code/font URLs, geometry and edits to dynamic user content", () => {
  const invalid = [
    (d) => { d.elements.body = { text: "x" }; },
    (d) => { d.elements["login.submit"] = { selector: "body", text: "x" }; },
    (d) => { d.elements["login.submit"] = { styles: { light: { backgroundColor: "red;display:none" } } }; },
    (d) => { d.elements["login.submit"] = { styles: { light: { fontFamily: "url(https://example.invalid/font)" } } }; },
    (d) => { d.elements["login.submit"] = { styles: { light: { fontSizePx: 999 } } }; },
    (d) => { d.elements["login.submit"] = { styles: { light: { width: 999 } } }; },
    (d) => { d.elements["login.card"] = { text: "replace all fields" }; },
    (d) => { d.sourceRevision = "main"; },
    (d) => { d.password = "must not persist"; }
  ];
  for (const mutate of invalid) { const doc = fixture(); mutate(doc); assert.throws(() => validatePointDesign(doc)); }
  const html = fixture(); html.elements["login.title"] = { text: "<script>alert(1)</script>" };
  assert.equal(validatePointDesign(html).elements["login.title"].text, html.elements["login.title"].text);
  assert.equal(CATALOG.some((item) => /profile\.name|password|users/.test(item.id)), false);
});

test("point editor preserves draft on save conflict and selection change, then explicit discard restores saved source", async () => {
  const doc = fixture(); let fail = true, saved;
  const service = new PointDesignService(root, async (clientId, sourceRevision, payload) => {
    if (payload) { if (fail) throw Error("conflict"); saved = payload.document; return { clientId, sourceRevision, revision: payload.expectedRevision + 1, document: saved }; }
    return { clientId, sourceRevision, revision: 0, document: doc };
  });
  const editor = new PointEditor(service);
  await editor.bind(doc.clientId, revision); editor.enable(true); editor.select({ id: "login.title", theme: "dark", computed: { password: "not forwarded", fontSizePx: 24 } });
  assert.equal(editor.get().computed.password, undefined);
  editor.change("login.title", { text: "Новый заголовок" });
  editor.select({ id: "login.submit" });
  editor.change("login.title", { text: "Последний ввод до выбора кнопки" });
  await assert.rejects(editor.save(), /conflict/);
  assert.equal(editor.get().dirty, true); assert.equal(editor.get().document.elements["login.title"].text, "Последний ввод до выбора кнопки");
  await assert.rejects(editor.bind(randomUUID(), revision), /Сначала сохраните/);
  fail = false; await editor.save(); assert.equal(editor.get().revision, 1); assert.equal(editor.get().dirty, false);
  editor.change("login.title", null); assert.equal(editor.get().dirty, true); editor.discard();
  assert.deepEqual(editor.get().document, saved);
});

test("point snapshot is immutable, empty data creates no artifact and legacy settings never enter it", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-point-design-"));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith("core-point-design-")); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.mkdir(path.join(directory, "infra/scripts"), { recursive: true });
  for (const name of ["client-design-contract.cjs", "point-design-contract.cjs"]) await fs.copyFile(path.join(root, "infra/scripts", name), path.join(directory, "infra/scripts", name));
  let doc = fixture();
  const service = new PointDesignService(directory, async (clientId, sourceRevision) => ({ clientId, sourceRevision, revision: 1, document: doc }));
  assert.equal(await service.captureOptional(doc.clientId, revision), undefined);
  doc.elements["login.title"] = { text: "Сохраненная подпись" };
  doc = validatePointDesign(doc);
  const ref = await service.captureOptional(doc.clientId, revision);
  assert.equal(ref.version, 3); assert.equal(ref.source, "saved");
  const file = path.join(directory, "infra/runtime/client-designs", ref.id, "design.json"), bytes = await fs.readFile(file, "utf8");
  doc = { ...doc, elements: { "login.title": { text: "После снимка" } } };
  assert.notEqual(await service.currentHash(doc.clientId, revision), ref.sha256);
  assert.equal(await fs.readFile(file, "utf8"), bytes);
  await assert.rejects(service.load(doc.clientId, "a".repeat(40)), /другому клиенту или версии/);
});
