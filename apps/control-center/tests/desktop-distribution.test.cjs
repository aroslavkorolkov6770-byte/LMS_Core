const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { safeRelative, linkDependencies, bundleDependencies } = require("../../../infra/desktop/dependency-bundle.cjs");
const { forbidden, copyProjectFile } = require("../../../infra/desktop/build-installer.cjs");
test("desktop distribution rejects private/workstation files and nonportable link targets", () => {
  for (const name of [".env", ".env.local", ".env.production.local", "launcher-config.json", "launcher-secrets.json", "runtime", "local-postgres", "data", ".git"]) assert.equal(forbidden.test(name), true, name);
  for (const value of ["../key", "C:/Users/owner", "x/../owner", "x\\secret", "/absolute", "x//y"]) assert.equal(safeRelative(value), false, value);
  assert.equal(safeRelative("apps/control-center/node_modules/ssh2"), true);
  assert.equal(copyProjectFile("apps/api", path.join("dist", "modules", "tests", "tests.module.js")), true);
  assert.equal(copyProjectFile("apps/api", path.join("src", "config", "app.config.ts")), true);
  assert.equal(copyProjectFile("apps/control-center", path.join("tests", "fixture.cjs")), false);
  assert.equal(copyProjectFile("apps/control-center", path.join("config", "launcher-config.json")), false);
});
test("downloaded Git/npm/Next build never inherits the desktop maintenance database secret", () => {
  const { preparationEnvironments } = require("../../../infra/scripts/prepare-lms-source.cjs");
  const result = preparationEnvironments({ PATH: "fixture-tools", CORE_DESKTOP_MODE: "1", CORE_TEST_BROWSER: "fixture-browser", DATABASE_URL: "fixture-private-maintenance", API_KEY: "fixture-private-key", DOCUMENT_STORAGE_ENCRYPTION_KEY: "fixture-private-key" });
  assert.equal(result.build.PATH, "fixture-tools"); assert.equal(result.build.DATABASE_URL, undefined); assert.equal(result.build.API_KEY, undefined);
  assert.equal(result.runtime.DATABASE_URL, "fixture-private-maintenance"); assert.equal(result.runtime.DOCUMENT_STORAGE_ENCRYPTION_KEY, undefined);
});
test("desktop links are relocatable junctions, repeat-safe and never overwrite ordinary user directories", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-desktop-test-"));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("core-desktop-test-")); await fs.rm(root, { recursive: true, force: true }); });
  const links = [{ from: "apps/control-center/node_modules/fixture", to: "vendor/npm/a" }];
  await fs.mkdir(path.join(root, "vendor/npm/a"), { recursive: true }); await fs.mkdir(path.join(root, "vendor/npm/b"));
  await linkDependencies(root, links); await linkDependencies(root, links);
  assert.equal(await fs.realpath(path.join(root, links[0].from)), await fs.realpath(path.join(root, links[0].to)));
  await assert.rejects(linkDependencies(root, [{ ...links[0], to: "vendor/npm/b" }]), /LINK_OCCUPIED/);
  await linkDependencies(root, [{ ...links[0], to: "vendor/npm/b" }], true);
  await fs.mkdir(path.join(root, "apps/control-center/node_modules/keep"));
  await assert.rejects(linkDependencies(root, [{ from: "apps/control-center/node_modules/keep", to: "vendor/npm/a" }], true), /LINK_OCCUPIED/);
  await assert.rejects(linkDependencies(root, [{ from: "../secret", to: "vendor/npm/a" }]), /LINK_INVALID/);
});

test("locked package graph keeps peers and package self-references without source-machine node_modules links", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "core-desktop-test-")), root = path.join(base, "input"), output = path.join(base, "output"), project = "apps/fixture";
  t.after(async () => { assert.equal(path.dirname(base), os.tmpdir()); assert.ok(path.basename(base).startsWith("core-desktop-test-")); await fs.rm(base, { recursive: true, force: true }); });
  const app = path.join(root, project), outer = path.join(app, "node_modules/outer"), peer = path.join(app, "node_modules/peer");
  await fs.mkdir(outer, { recursive: true }); await fs.mkdir(peer); await fs.mkdir(path.join(output, project), { recursive: true });
  await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: { outer: "1", peer: "1" } }));
  await fs.copyFile(path.join(app, "package.json"), path.join(output, project, "package.json"));
  await fs.writeFile(path.join(outer, "package.json"), JSON.stringify({ name: "outer", version: "1.0.0", main: "index.js", peerDependencies: { peer: "1" } }));
  await fs.writeFile(path.join(outer, "index.js"), 'module.exports = require("outer/lib.js") + require("peer");');
  await fs.writeFile(path.join(outer, "lib.js"), 'module.exports = "self+";');
  await fs.writeFile(path.join(peer, "package.json"), JSON.stringify({ name: "peer", version: "1.0.0", main: "index.js" }));
  await fs.writeFile(path.join(peer, "index.js"), 'module.exports = "peer";');
  const graph = await bundleDependencies(root, output, [project]); await linkDependencies(output, graph.links);
  const request = require("node:module").createRequire(path.join(output, project, "package.json"));
  assert.equal(request("outer"), "self+peer"); assert.equal(graph.packages.length, 3);
  assert.ok(graph.links.some(link => link.from.endsWith("/node_modules/outer") && link.to.startsWith("vendor/npm/")));
});
