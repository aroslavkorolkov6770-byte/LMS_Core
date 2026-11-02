const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ensureLocalApiBuild } = require("../../../infra/scripts/local-api-build.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-api-build-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-api-build-")); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write("tsconfig.base.json", "{}"); write("pnpm-lock.yaml", "fixture");
  for (const directory of ["packages/shared", "packages/db", "apps/api"]) {
    write(directory + "/package.json", "{}"); write(directory + "/tsconfig.json", "{}"); write(directory + "/src/index.ts", "export const fixture = 1;");
  }
  let calls = 0;
  const compile = (_root, project) => { calls++; write(project + "/dist/" + (project === "apps/api" ? "main.js" : project === "packages/db" ? "src/index.js" : "index.js"), "module.exports = {};"); };
  return { root, write, compile, calls: () => calls, receipt: path.join(root, "infra/runtime/local-builds/api.json") };
}

test("compiled API cache keys content, not a timestamp of one unchanged emitted file", (t) => {
  const f = fixture(t);
  assert.equal(ensureLocalApiBuild(f.root, f.compile).rebuilt, true); assert.equal(f.calls(), 3);
  const source = path.join(f.root, "apps/api/src/index.ts"); fs.utimesSync(source, new Date(), new Date());
  assert.equal(ensureLocalApiBuild(f.root, f.compile).rebuilt, false); assert.equal(f.calls(), 3);
  f.write("apps/api/src/index.ts", "export const fixture = 2;");
  assert.equal(ensureLocalApiBuild(f.root, f.compile).rebuilt, true); assert.equal(f.calls(), 6);
});

test("changed or missing runtime output forces compilation even with an existing receipt", (t) => {
  const f = fixture(t); ensureLocalApiBuild(f.root, f.compile);
  f.write("apps/api/dist/main.js", "modified output"); ensureLocalApiBuild(f.root, f.compile); assert.equal(f.calls(), 6);
  fs.unlinkSync(path.join(f.root, "packages/shared/dist/index.js")); ensureLocalApiBuild(f.root, f.compile); assert.equal(f.calls(), 9);
});

test("compiler failure never records a successful API build", (t) => {
  const f = fixture(t);
  assert.throws(() => ensureLocalApiBuild(f.root, () => { throw Error("fixture compile failed"); }));
  assert.equal(fs.existsSync(f.receipt), false);
  assert.equal(ensureLocalApiBuild(f.root, f.compile).rebuilt, true);
});

test("sources changed during compilation are refused before API execution", (t) => {
  const f = fixture(t);
  assert.throws(() => ensureLocalApiBuild(f.root, (root, project) => { f.compile(root, project); if (project === "apps/api") f.write("apps/api/src/index.ts", "export const fixture = 3;"); }), /LOCAL_API_BUILD_INPUT_CHANGED/);
  assert.equal(fs.existsSync(f.receipt), false);
});
