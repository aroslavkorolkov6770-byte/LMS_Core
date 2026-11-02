const test = require("node:test");
const assert = require("node:assert/strict");
const { readInstallationSnapshot } = require("../renderer/workspace-tools.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

test("installation reads: all independent local getters start before the first completes", async () => {
  const calls = [], gates = [deferred(), deferred(), deferred()];
  const snapshot = readInstallationSnapshot({
    getInstallationPlan: (id) => { calls.push(["plan", id]); return gates[0].promise; },
    getInstallationState: (id) => { calls.push(["state", id]); return gates[1].promise; },
    getIpPublication: (id) => { calls.push(["publication", id]); return gates[2].promise; }
  }, "client-a");
  let completed = false; void snapshot.then(() => { completed = true; });
  await Promise.resolve();
  assert.deepEqual(calls, [["plan", "client-a"], ["state", "client-a"], ["publication", "client-a"]]);
  gates[1].resolve({ phase: "succeeded" }); gates[2].resolve({ host: "fixture.local" });
  await Promise.resolve(); assert.equal(completed, false);
  gates[0].resolve({ id: "plan-a" });
  assert.deepEqual(await snapshot, { plan: { id: "plan-a" }, state: { phase: "succeeded" }, publication: { host: "fixture.local" } });
});

test("installation reads: an error cannot return a partially ready snapshot", async () => {
  const snapshot = readInstallationSnapshot({
    getInstallationPlan: async () => ({ status: "prepared" }),
    getInstallationState: async () => { throw Error("Fixture read failed"); },
    getIpPublication: async () => ({ phase: "succeeded" })
  }, "client-a");
  await assert.rejects(snapshot, /Fixture read failed/);
});

test("installation reads: optional bridge methods remain compatible and no result is cached", async () => {
  let reads = 0;
  const bridge = { getInstallationPlan: async id => ({ id, revision: ++reads }) };
  assert.deepEqual(await readInstallationSnapshot(bridge, "client-a"), { plan: { id: "client-a", revision: 1 }, state: null, publication: null });
  assert.deepEqual(await readInstallationSnapshot(bridge, "client-b"), { plan: { id: "client-b", revision: 2 }, state: null, publication: null });
});

test("installation reads: a synchronous bridge error is a rejected read, not a ready fallback", async () => {
  await assert.rejects(readInstallationSnapshot({ getInstallationPlan() { throw Error("Bridge unavailable"); } }, "client-a"), /Bridge unavailable/);
});
