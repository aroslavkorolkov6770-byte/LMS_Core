const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createClientChoiceStore } = require("../renderer/client-choice.js");

test("client choice: legacy keys remain compatible and an ordinary new store reloads the choice", () => {
  const values = new Map([["unrelated", "keep"]]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const first = createClientChoiceStore(() => storage);
  first.set("id", "fixture-id"); first.set("name", "Клиент");
  const reopened = createClientChoiceStore(() => storage);
  assert.equal(reopened.get("id"), "fixture-id"); assert.equal(reopened.get("name"), "Клиент");
  assert.equal(values.get("unrelated"), "keep");
});

test("client choice: unavailable getter falls back to memory and warns only once", () => {
  let accesses = 0, warnings = 0;
  const store = createClientChoiceStore(() => { accesses++; throw new Error("Fixture unavailable"); }, () => warnings++);
  assert.equal(store.get("id"), ""); store.set("id", "a"); store.set("name", "A");
  for (let index = 0; index < 20; index++) assert.equal(store.get("id"), "a");
  assert.equal(store.get("name"), "A"); assert.equal(accesses, 1); assert.equal(warnings, 1);
});

test("client choice: a failed write retains the new selection instead of reading back the old value", () => {
  let failWrite = false;
  const storage = { getItem: () => "old", setItem: () => { if (failWrite) throw new Error("Fixture quota"); } };
  const store = createClientChoiceStore(() => storage);
  assert.equal(store.get("id"), "old"); failWrite = true; store.set("id", "new");
  assert.equal(store.get("id"), "new");
});

test("client choice: invalid values are bounded and prototype keys never access storage", () => {
  let accesses = 0;
  const store = createClientChoiceStore(() => { accesses++; return { getItem: () => "x".repeat(1001), setItem() {} }; });
  assert.equal(store.get("name"), ""); store.set("id", "x".repeat(129)); assert.equal(store.get("id"), "");
  store.set("name", "bad\nname");
  assert.throws(() => store.get("__proto__"), /Unknown/); assert.throws(() => store.set("constructor", "x"), /Unknown/);
  assert.equal(accesses, 4);
});

test("client choice: warning failure is contained and browser export does not require Node", () => {
  const store = createClientChoiceStore(() => { throw new Error("fixture"); }, () => { throw new Error("warning"); });
  store.set("id", "a"); assert.equal(store.get("id"), "a");
  const browser = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/client-choice.js"), "utf8"), browser);
  assert.equal(typeof browser.coreClientChoice.createClientChoiceStore, "function");
});
