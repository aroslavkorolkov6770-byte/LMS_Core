const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { SourceLibraryStore } = require("../dist/source-library.js");

async function fixture(t, url = "git@github.com:fixture/current.git") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-source-library-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-source-library-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const current = { url, branch: "main", identityMode: "managed", identityFile: "" };
  const create = () => new SourceLibraryStore(root, async () => current);
  return { root, file: path.join(root, "infra/runtime/source-library.json"), current, create, store: create() };
}

test("the current repository is imported once, without changing its connection", async (t) => {
  const f = await fixture(t), before = JSON.stringify(f.current);
  const state = await f.store.get();
  assert.equal(state.sources.length, 1); assert.equal(state.sources[0].name, "current");
  assert.equal(state.sources[0].note, ""); assert.equal(state.sources[0].branch, "main");
  f.current.url = "git@github.com:fixture/another.git";
  assert.equal((await f.create().get()).sources[0].url, "git@github.com:fixture/current.git");
  assert.equal(JSON.parse(before).identityMode, f.current.identityMode);
});

test("an empty library is persisted and not reseeded on subsequent launches", async (t) => {
  const f = await fixture(t, "");
  assert.equal((await f.store.get()).sources.length, 0);
  f.current.url = "git@github.com:fixture/later.git";
  assert.equal((await f.create().get()).sources.length, 0);
});

test("names, branches and multiline notes survive reopening; editing preserves entry identity", async (t) => {
  const f = await fixture(t, ""), initial = await f.store.get();
  const first = await f.store.save({ name: "  Client library  ", url: "git@github.com:fixture/lms.git", branch: "release/one", note: "For a client\r\nSecond line", token: "fixture-private-token" }, initial.revision);
  const entry = first.sources[0];
  assert.equal(entry.note, "For a client\nSecond line"); assert.equal(entry.name, "Client library");
  const reopened = await f.create().get(); assert.deepEqual(reopened, first);
  const edited = await f.store.save({ ...entry, note: "Changed note" }, first.revision);
  assert.equal(edited.sources[0].id, entry.id); assert.equal(edited.sources[0].createdAt, entry.createdAt);
  assert.equal(edited.sources[0].note, "Changed note"); assert.equal(edited.revision, first.revision + 1);
  assert.equal((await fs.readFile(f.file, "utf8")).includes("fixture-private-token"), false);
});

test("duplicates are rejected but a different branch is a separate source", async (t) => {
  const f = await fixture(t), state = await f.store.get(), entry = state.sources[0];
  await assert.rejects(f.store.save({ ...entry, id: undefined }, state.revision), /уже добавлен/);
  const second = await f.store.save({ ...entry, id: undefined, branch: "another" }, state.revision);
  assert.equal(second.sources.length, 2);
});

test("stale or concurrent writes do not silently replace another note", async (t) => {
  const f = await fixture(t), state = await f.store.get(), entry = state.sources[0];
  const results = await Promise.allSettled([f.store.save({ ...entry, note: "first" }, state.revision), f.store.save({ ...entry, note: "second" }, state.revision)]);
  assert.equal(results.filter((value) => value.status === "fulfilled").length, 1);
  assert.match(results.find((value) => value.status === "rejected").reason.message, /Список изменился/);
  assert.equal((await f.store.get()).sources[0].note, "first");
});

test("invalid addresses and oversized notes never alter the saved library", async (t) => {
  const f = await fixture(t), state = await f.store.get(), entry = state.sources[0], before = await fs.readFile(f.file, "utf8");
  for (const change of [{ name: "" }, { note: "x".repeat(1001) }, { url: "https://user:password@github.com/owner/repo" }, { url: "-----BEGIN PRIVATE KEY-----" }, { id: "invalid" }, { name: "bad\nname" }]) await assert.rejects(f.store.save({ ...entry, ...change }, state.revision));
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("a damaged library is kept intact and cannot be overwritten by a save", async (t) => {
  const f = await fixture(t); await f.store.get();
  await fs.writeFile(f.file, "{damaged original}");
  await assert.rejects(f.store.get(), /поврежден/);
  await assert.rejects(f.store.save({ name: "New", url: f.current.url, branch: "", note: "" }, 0), /поврежден/);
  assert.equal(await fs.readFile(f.file, "utf8"), "{damaged original}");
});
