const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRefreshQueue } = require("../renderer/refresh-queue.js");
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("refresh queue: normal calls share one active read and completed data is not cached", async () => {
  const first = deferred(); let calls = 0;
  const queue = createRefreshQueue(() => { calls++; return calls === 1 ? first.promise : "new"; });
  const a = queue.request(), b = queue.request(); assert.equal(a, b);
  first.resolve("first"); assert.equal(await a, "first"); assert.equal(calls, 1);
  assert.equal(await queue.request(), "new"); assert.equal(calls, 2);
});

test("refresh queue: a fresh read is shared without downgrading it to normal", async () => {
  const pending = deferred(), modes = [];
  const queue = createRefreshQueue((fresh) => { modes.push(fresh); return pending.promise; });
  const a = queue.request(true); assert.equal(queue.request(false), a); assert.equal(queue.request(true), a);
  pending.resolve(1); await a; assert.deepEqual(modes, [true]);
});

test("refresh queue: one queued fresh read serves every request behind a normal read", async () => {
  const normal = deferred(), fresh = deferred(), modes = []; let active = 0, peak = 0;
  const queue = createRefreshQueue(async (force) => { modes.push(force); active++; peak = Math.max(peak, active); try { return await (force ? fresh.promise : normal.promise); } finally { active--; } });
  const a = queue.request(false), b = queue.request(true);
  for (let index = 0; index < 20; index++) assert.equal(queue.request(index % 2 === 0), b);
  normal.resolve("normal"); assert.equal(await a, "normal");
  await Promise.resolve(); assert.deepEqual(modes, [false, true]);
  fresh.resolve("fresh"); assert.equal(await b, "fresh"); assert.equal(peak, 1);
});

test("refresh queue: a normal caller cannot slip into the completion gap before queued fresh", async () => {
  const normal = deferred(), forced = deferred(), modes = [];
  const queue = createRefreshQueue((fresh) => { modes.push(fresh); return fresh ? forced.promise : normal.promise; });
  const first = queue.request(false);
  const continuation = first.then(() => queue.request(false));
  const fresh = queue.request(true);
  normal.resolve("old"); await first; await Promise.resolve();
  forced.resolve("new"); assert.equal(await continuation, "new"); assert.equal(await fresh, "new");
  assert.deepEqual(modes, [false, true]);
});

test("refresh queue: failed normal read does not suppress a requested fresh retry", async () => {
  const normal = deferred(), modes = [];
  const queue = createRefreshQueue((fresh) => { modes.push(fresh); return fresh ? "recovered" : normal.promise; });
  const first = queue.request(false); const rejected = assert.rejects(first, /fixture/);
  const fresh = queue.request(true); normal.reject(new Error("fixture"));
  await rejected; assert.equal(await fresh, "recovered"); assert.deepEqual(modes, [false, true]);
});

test("refresh queue: synchronous and queued failures always release the queue", async () => {
  let failure = true;
  const queue = createRefreshQueue(() => { if (failure) throw new Error("fixture"); return 0; });
  const first = queue.request(), fresh = queue.request(true);
  await Promise.all([assert.rejects(first, /fixture/), assert.rejects(fresh, /fixture/)]);
  failure = false; assert.equal(await queue.request(), 0); assert.equal(await queue.request(true), 0);
});

test("refresh queue: the same implementation exports correctly into a browser without Node", async () => {
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/refresh-queue.js"), "utf8"), browser);
  assert.equal(typeof browser.coreRefreshQueue.createRefreshQueue, "function");
  assert.equal(await browser.coreRefreshQueue.createRefreshQueue((fresh) => fresh).request(true), true);
});
