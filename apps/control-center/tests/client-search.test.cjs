const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = createRequire(path.resolve(__dirname, "../package.json"))("typescript");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../deploy-panel/app/client-search.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: exportsObject });
const { filterClients } = exportsObject;
const clients = [{ id: "a", name: "Кофейня Север", brandName: "Aurora", domain: "north.example" }, { id: "b", name: "Ритейл", brandName: "Ватэс", domain: "shop.example" }];

test("client search: empty query preserves source identity and order", () => {
  assert.equal(filterClients(clients, " \t "), clients);
});
test("client search: terms match case-insensitive name, brand and domain without changing records", () => {
  for (const query of ["СЕВЕР", "aurora", "NORTH.EXAMPLE", "кофейня north"]) assert.equal(filterClients(clients, query)[0], clients[0]);
  assert.equal(filterClients(clients, "ВАТЭС")[0], clients[1]);
  assert.equal(filterClients(clients, "north ритейл").length, 0);
  assert.equal(clients.length, 2);
});
test("client search: literal punctuation is not interpreted as regex or markup", () => {
  assert.equal(filterClients(clients, ".*").length, 0);
  assert.equal(filterClients(clients, "<img>").length, 0);
  assert.equal(filterClients([], "a").length, 0);
});
test("client search: input work is capped to the same 200 character UI limit", () => {
  const item = { name: "x".repeat(200), brandName: "", domain: "" };
  assert.equal(filterClients([item], "x".repeat(200) + " ignored")[0], item);
});
