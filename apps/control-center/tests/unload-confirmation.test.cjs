const test = require("node:test");
const assert = require("node:assert/strict");
const { confirmPreventedUnload } = require("../dist/unload-confirmation.js");

test("unload confirmation: stay and dialog cancellation retain the draft", () => {
  for (const choice of [0, -1, undefined, null, "1", 2]) {
    let discarded = 0;
    assert.equal(confirmPreventedUnload({ preventDefault: () => discarded++ }, () => choice), false);
    assert.equal(discarded, 0);
  }
});

test("unload confirmation: only explicit discard allows leaving", () => {
  let asked = 0, discarded = 0;
  assert.equal(confirmPreventedUnload({ preventDefault: () => discarded++ }, () => { asked++; return 1; }), true);
  assert.equal(asked, 1);
  assert.equal(discarded, 1);
});

test("unload confirmation: dialog error does not discard", () => {
  let discarded = 0;
  assert.equal(confirmPreventedUnload({ preventDefault: () => discarded++ }, () => { throw Error("Fixture native failure"); }), false);
  assert.equal(discarded, 0);
});
