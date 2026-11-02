const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const { PointDesignService, PointEditor } = require("../dist/point-design.js");
const { emptyPointDesign, FONTS } = require("../../../infra/scripts/point-design-contract.cjs");
const { root } = require("./runtime-test-helper.cjs");

test("real inspector coalesces color input without losing a font edit; save flushes the last draft and cancel is local", { timeout: 45000 }, async () => {
  const clientId = randomUUID(), revision = "a".repeat(40), doc = emptyPointDesign(clientId, revision);
  let saves = 0, localChanges = 0;
  const service = new PointDesignService(root, async (_client, _source, payload) => payload ? (++saves, { clientId, sourceRevision: revision, revision: 1, document: payload.document }) : { clientId, sourceRevision: revision, revision: 0, document: doc });
  const editor = new PointEditor(service); await editor.bind(clientId, revision); editor.enable(true); editor.select({ id: "login.submit", theme: "light" });
  const browser = await chromium.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const index = await fs.readFile(path.join(root, "apps/control-center/renderer/index.html"), "utf8");
    const inspector = index.slice(index.indexOf('<aside id="point-inspector"'), index.indexOf("</aside>", index.indexOf('<aside id="point-inspector"')) + 8);
    await page.setContent(`<style>.hidden{display:none}</style><button id="point-editor-toggle">Редактировать</button><div id="point-workspace">${inspector}</div>`);
    await page.exposeFunction("command", async (method, args) => {
      if (method === "get") return editor.get();
      if (method === "enable") return editor.enable(args[0]);
      if (method === "change") { localChanges++; await new Promise((resolve) => setTimeout(resolve, 40)); return editor.change(...args); }
      if (method === "save") return editor.save();
      if (method === "discard") return editor.discard();
      if (method === "reload") return editor.reload();
      if (method === "select") { editor.select({ id: args[0] }); return editor.get(); }
      throw Error("Unknown inspector method");
    });
    await page.addScriptTag({ path: path.join(root, "apps/control-center/renderer/point-editor.js") });
    await page.evaluate(() => {
      const call = (method) => (...args) => window.command(method, args);
      window.inspector = CorePointInspector.create({ bridge: { getPointEditor: call("get"), enablePointEditor: call("enable"), changePointElement: call("change"), savePointEditor: call("save"), discardPointEditor: call("discard"), reloadPointEditor: call("reload"), selectPointElement: call("select"), onPointEditorState: () => {} }, layout: () => {} });
      window.inspector.setReady(true);
    });
    await page.waitForFunction(() => !document.getElementById("point-editor-toggle").disabled);
    await page.locator("#point-editor-toggle").click();
    await page.locator("#point-font").selectOption(FONTS.humanist);
    await page.evaluate(() => {
      const picker = document.querySelector('[data-point-color="backgroundColor"]');
      for (let i = 0; i < 80; i++) { picker.value = "#1234" + i.toString(16).padStart(2, "0"); picker.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await page.locator("#point-text").fill("Войти в кабинет клиента");
    await page.locator("#point-save").click();
    await page.waitForFunction(() => document.getElementById("point-save").disabled);
    const saved = editor.get();
    assert.equal(saves, 1); assert.equal(saved.dirty, false);
    assert.deepEqual(saved.document.elements["login.submit"], { text: "Войти в кабинет клиента", styles: { light: { fontFamily: FONTS.humanist, backgroundColor: "#12344f" } } });
    assert.ok(localChanges < 12, "Color updates should be coalesced, not rebuild/save on every input");
    await page.locator("#point-text").fill("Несохраненная подпись");
    await page.locator("#point-discard").click();
    await page.waitForFunction(() => !window.inspector.hasUnsaved());
    assert.deepEqual(editor.get().document, saved.document); assert.equal(saves, 1);
    await page.locator("#point-text").fill("Черновик после остановки просмотра");
    await page.evaluate(async () => { await window.inspector.flush(); window.inspector.setReady(false); });
    assert.equal(await page.locator("#point-reload").isEnabled(), true);
    assert.equal(await page.locator("#point-save").isEnabled(), true);
    assert.equal(await page.locator("#point-text").isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
