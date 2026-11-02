const test = require("node:test");
const assert = require("node:assert/strict");
const { PageReadinessCache } = require("../dist/page-readiness-cache.js");
const healthy = (message = "ready") => ({ healthState: "healthy", checkedAt: "2026-10-28T20:00:00Z", responseTimeMs: 1, message });

test("HTML cache keeps actual check time, expires and permits an explicit fresh check", async () => {
  let now = 0, calls = 0;
  const cache = new PageReadinessCache(15000, () => now);
  const load = async () => { calls++; return healthy(); };
  const first = await cache.check("lms:3100", load);
  now = 14000;
  for (let i = 0; i < 10; i++) assert.equal((await cache.check("lms:3100", load)).checkedAt, first.checkedAt);
  assert.equal(calls, 1);
  await cache.check("lms:3100", load, true); assert.equal(calls, 2);
  now += 15001; await cache.check("lms:3100", load); assert.equal(calls, 3);
  await cache.check("panel:3002", load); assert.equal(calls, 4);
});

test("failed readiness is never cached and a fresh failure discards an old success", async () => {
  const cache = new PageReadinessCache(); let calls = 0;
  await cache.check("a", async () => healthy());
  const fail = async () => { calls++; return { ...healthy(), healthState: "unhealthy" }; };
  await cache.check("a", fail, true); await cache.check("a", fail); assert.equal(calls, 2);
});

test("pending checks coalesce and invalidation prevents an old process result replacing the new one", async () => {
  const cache = new PageReadinessCache(); let release, calls = 0;
  const load = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const a = cache.check("a", load), b = cache.check("a", load, true);
  await Promise.resolve(); assert.equal(calls, 1);
  cache.invalidate(); await cache.check("a", async () => healthy("new"));
  release(healthy("old")); assert.equal((await a).message, "old"); await b;
  assert.equal((await cache.check("a", async () => { throw Error("must use current cache"); })).message, "new");
});

test("a thrown loader does not leave the cache permanently busy", async () => {
  const cache = new PageReadinessCache();
  await assert.rejects(cache.check("a", () => { throw Error("fixture failure"); }), /fixture failure/);
  assert.equal((await cache.check("a", async () => healthy())).healthState, "healthy");
});
