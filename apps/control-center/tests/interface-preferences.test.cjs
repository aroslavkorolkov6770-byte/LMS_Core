const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { normalize, defaults, themes } = require("../renderer/preferences.js");
const { InterfacePreferencesStore } = require("../dist/interface-preferences.js");
const { logTail, navigationShortcut } = require("../renderer/workspace-tools.js");

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-interface-prefs-"));
  try { await run(path.join(directory, "interface.json")); }
  finally {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("core-interface-prefs-"));
    await fs.rm(target, { recursive: true, force: true });
  }
}

test("interface preferences: eight named palettes and safe defaults", () => {
  assert.equal(Object.keys(themes).length, 8);
  for (const input of [null, [], "invalid", 42]) assert.deepEqual(normalize(input), defaults);
  assert.equal(Object.values(themes).filter((theme) => theme.light).length, 3);
});

test("interface preferences: reject arbitrary values, secrets, and remote policy", () => {
  const result = normalize({ theme: "url(evil)", statusInterval: 1, density: "invalid", textSize: 999, maximizeOnStart: "false", password: "not-stored", executionMode: "remote", __proto__: { defaultView: "repository" } });
  assert.deepEqual(result, defaults);
  assert.equal(JSON.stringify(result).includes("not-stored"), false);
  assert.equal(Object.hasOwn(result, "executionMode"), false);
});

test("interface preferences: valid appearance and behavior survive normalization", () => {
  const input = { ...defaults, theme: "porcelain", statusInterval: 30000, autoRefreshLogs: false, density: "compact", textSize: "large", sidebarWidth: "narrow", reducedMotion: true, maximizeOnStart: false };
  assert.deepEqual(normalize(input), input);
  assert.equal(normalize({ defaultView: "lms" }).defaultView, "lms");
});

test("interface preferences: extended controls migrate and persist without remote fields", async () => fixture(async (file) => {
  const values = { ...defaults, uiFont: "humanist", contentWidth: "focused", borderContrast: "strong", showServiceSummary: false, keyboardShortcuts: false, logWrap: true, logLineLimit: 300, logInterval: 10000 };
  assert.deepEqual(normalize(values), values);
  assert.deepEqual(normalize({ uiFont: "url(evil)", contentWidth: "10000px", logInterval: 1, logLineLimit: Infinity, showServiceSummary: "false" }), defaults);
  const store = new InterfacePreferencesStore(file); await store.load(); await store.save(values); await store.flush();
  const reloaded = new InterfacePreferencesStore(file); await reloaded.load();
  assert.deepEqual(reloaded.peek(), values);
}));

test("workspace tools: log tail handles empty, CRLF, and trailing newlines", () => {
  assert.equal(logTail(null, 300), "");
  assert.equal(logTail("one\r\ntwo\r\n", 300), "one\r\ntwo\r\n");
  for (const ending of ["", "\n"]) {
    const source = Array.from({ length: 500 }, (_, index) => String(index + 1)).join("\n") + ending;
    assert.equal(logTail(source, 300), Array.from({ length: 300 }, (_, index) => String(index + 201)).join("\n") + ending);
  }
  assert.equal(logTail("short", -1), "short");
});

test("workspace tools: shortcuts respect text input, dialogs, modifiers, and opt out", () => {
  const event = { ctrlKey: true, code: "Digit4" };
  assert.equal(navigationShortcut(event, true, false, false), "lms");
  assert.equal(navigationShortcut({ ...event, code: "Comma" }, true, false, false), "settings");
  for (const flags of [[false, false, false], [true, true, false], [true, false, true]]) assert.equal(navigationShortcut(event, ...flags), null);
  for (const key of ["defaultPrevented", "repeat", "altKey", "metaKey", "shiftKey"]) assert.equal(navigationShortcut({ ...event, [key]: true }, true, false, false), null);
  assert.equal(navigationShortcut({ code: "Digit1" }, true, false, false), null);
});

test("interface preferences: migrate old browser preferences and reload from disk", async () => fixture(async (file) => {
  const store = new InterfacePreferencesStore(file);
  await store.load();
  assert.equal((await store.read({ theme: "sand", defaultView: "browser", autoFocusPreview: false })).preferences.theme, "sand");
  const second = new InterfacePreferencesStore(file);
  await second.load();
  const read = await second.read({ theme: "midnight" });
  assert.equal(read.preferences.theme, "sand");
  assert.equal(read.preferences.defaultView, "browser");
  assert.equal(read.preferences.autoFocusPreview, false);
  assert.equal(read.warning, "");
}));

test("interface preferences: rapid writes finish in order and exclude unknown fields", async () => fixture(async (file) => {
  const store = new InterfacePreferencesStore(file);
  await store.load();
  const writes = Object.keys(themes).map((theme) => store.save({ theme, password: "discard-this", executionMode: "remote" }));
  await Promise.all(writes);
  await store.flush();
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(record.version, 1);
  assert.equal(record.preferences.theme, "mist");
  assert.equal(JSON.stringify(record).includes("discard-this"), false);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["interface.json"]);
}));

test("interface preferences: corrupted file preserved until explicit save", async () => fixture(async (file) => {
  await fs.writeFile(file, "broken-json");
  const store = new InterfacePreferencesStore(file);
  await store.load();
  const result = await store.read({ theme: "sand" });
  assert.ok(result.warning);
  assert.equal(result.preferences.theme, "midnight");
  assert.equal(await fs.readFile(file, "utf8"), "broken-json");
  await store.save({ theme: "ocean" });
  assert.equal((await store.read()).warning, "");
}));

test("interface preferences: incompatible or oversized settings fail safely", async () => fixture(async (file) => {
  for (const contents of [JSON.stringify({ version: 2, preferences: { theme: "sand" } }), " ".repeat(17000)]) {
    await fs.writeFile(file, contents);
    const store = new InterfacePreferencesStore(file);
    await store.load();
    assert.ok((await store.read()).warning);
    assert.deepEqual(store.peek(), defaults);
  }
}));

test("interface preferences: a write failure does not replace current preferences", async () => fixture(async (file) => {
  await fs.mkdir(file);
  const store = new InterfacePreferencesStore(path.join(file, "preferences.json"));
  await store.load();
  await fs.rmdir(file);
  await fs.writeFile(file, "blocking-file");
  await assert.rejects(store.save({ theme: "forest" }));
  assert.equal(store.peek().theme, "midnight");
}));
