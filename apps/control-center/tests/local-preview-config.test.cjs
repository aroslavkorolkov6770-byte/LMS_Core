const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { configuration } = require("../../../infra/scripts/run-local-next.cjs");
const { resolveLocalPreviewOrigin, DEFAULT_LOCAL_PREVIEW_ORIGIN } = require("../../../packages/shared/dist/index.js");

test("local preview address rejects remote URLs, credentials and non-origin paths", () => {
  assert.equal(DEFAULT_LOCAL_PREVIEW_ORIGIN, "http://127.0.0.1:3100");
  assert.equal(resolveLocalPreviewOrigin("http://127.0.0.1:3217"), "http://127.0.0.1:3217");
  for (const value of [undefined, "bad", "https://example.com:3100", "http://user:secret@127.0.0.1:3100", "http://127.0.0.1:3100/other", "http://127.0.0.1:3100?x=1", "http://127.0.0.1:80"]) assert.equal(resolveLocalPreviewOrigin(value), DEFAULT_LOCAL_PREVIEW_ORIGIN);
});

test("Next launcher reads its port from Core config and refuses a duplicate service port", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-local-next-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-local-next-")); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "apps/control-center/config/launcher-config.json"); await fs.mkdir(path.dirname(file), { recursive: true });
  const config = { services: [{ id: "lms-web", port: 3217 }, { id: "deploy-panel", port: 3002 }] };
  await fs.writeFile(file, JSON.stringify(config));
  assert.equal(configuration("lms-web", "dev", root).port, 3217);
  assert.equal(configuration("lms-web", "start", root).origin, "http://127.0.0.1:3217");
  assert.equal(configuration("deploy-panel", "dev", root).port, 3002);
  assert.equal(configuration("deploy-panel", "dev", root).previewOrigin, "http://127.0.0.1:3217");
  assert.throws(() => configuration("other", "dev", root)); assert.throws(() => configuration("lms-web", "eval", root));
  config.services[1].port = 3217; await fs.writeFile(file, JSON.stringify(config));
  assert.throws(() => configuration("lms-web", "dev", root));
});

test("panel uses the current TS shared entry while deployable LMS scripts stay independent of Core tools", async () => {
  const root = path.resolve(__dirname, "../../..");
  const next = require("../../deploy-panel/next.config.js");
  const config = next.webpack({ resolve: { alias: { existing: "preserved" } } });
  assert.equal(config.resolve.alias.existing, "preserved");
  assert.equal(config.resolve.alias["@lms-core/shared$"], path.join(root, "packages/shared/src/index.ts"));
  const pkg = JSON.parse(await fs.readFile(path.join(root, "apps/lms-web/package.json"), "utf8"));
  assert.ok(pkg.scripts.dev.startsWith("next dev ")); assert.ok(pkg.scripts.start.startsWith("next start "));
  assert.ok(!JSON.stringify(pkg.scripts).includes("infra/scripts"));
});
