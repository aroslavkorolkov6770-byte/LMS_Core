const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const adapter = require("../dist/support-contact-adapter.js");
const upgrade = require("../../../infra/scripts/support-contact-upgrade.cjs");
const root = path.resolve(__dirname, "../../.."), source = path.join(root, "infra/runtime/source-cache/f0140c68-d136-4fe2-aa40-80d9ae2e5185/source");
test("company-details contact contract preserves company identity and replaces only support rendering", () => {
  const footer = 'import React from "react"; export default function Footer(){return <footer><p>{COMPANY_DETAILS.name}</p>{hasCompanyDetail(COMPANY_DETAILS.supportEmail) ? (<a className="vates-footer-support-email" href={`mailto:${COMPANY_DETAILS.supportEmail}`}>{COMPANY_DETAILS.supportEmail}</a>) : (<span className="vates-footer-support-email">{COMPANY_DETAILS.supportEmail}</span>)}</footer>}';
  const result = adapter.adaptSupportSource(footer, "footer");
  assert.ok(result.includes("{COMPANY_DETAILS.name}")); assert.ok(result.includes("<SupportEmail")); assert.ok(result.includes('emptyLabel=""')); assert.ok(!result.includes("COMPANY_DETAILS.supportEmail"));
  assert.throws(() => adapter.adaptSupportSource(footer.replace('className="vates-footer-support-email"', 'className="unknown"'), "footer"), /CONTRACT_CHANGED/);
  const privacy = 'import React from "react"; const lines = [`One ${COMPANY_DETAILS.supportEmail}`,`Two ${COMPANY_DETAILS.supportEmail}`,`Three ${COMPANY_DETAILS.supportEmail}`]; export default function Privacy(){return <><p>{block.text}</p><p>{block.intro}</p><li>{item}</li><p>{COMPANY_DETAILS.name}</p></>}';
  const next = adapter.adaptSupportSource(privacy, "privacy");
  assert.equal(next.split("__CORE_SUPPORT_EMAIL__").length - 1, 3); assert.equal(next.split("<SupportText").length - 1, 3); assert.ok(next.includes("{COMPANY_DETAILS.name}"));
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-contact-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("core-contact-")); await fs.rm(directory, { recursive: true, force: true }); });
  const app = path.join(directory, "lms"), patch = await adapter.prepareSupportPatch(root, source);
  await fs.mkdir(path.join(app, "node_modules"), { recursive: true }); await fs.mkdir(path.join(app, ".next"));
  await fs.writeFile(path.join(app, ".next/BUILD_ID"), "old-build");
  for (const file of patch.files.filter(file => file.beforeSha256)) { await fs.mkdir(path.dirname(path.join(app, file.path)), { recursive: true }); await fs.copyFile(path.join(source, file.path), path.join(app, file.path)); }
  await fs.writeFile(path.join(app, "package.json"), '{"scripts":{"build":"next build"}}');
  const calls = [], e = { app, c: { operationId: crypto.randomUUID(), webPort: 1 }, unit: "fixture-web.service", regular: file => fs.readFile(file, "utf8"), run: async (file, args) => { calls.push([file, ...args]); } };
  const options = { fixture: true, build: async stage => { await fs.mkdir(path.join(stage, ".next")); await fs.writeFile(path.join(stage, ".next/BUILD_ID"), "new-build"); }, contactFetch: async () => ({ ok: true, text: async () => JSON.stringify({ protocol: "lms-core-support-contact-v1", supportEmail: "support@example.invalid" }) }) };
  return { directory, app, patch, calls, e, options };
}

test("contact adapter changes only the approved support addresses and keeps the source cache untouched", async () => {
  const footer = await fs.readFile(path.join(source, "app/components/Footer.tsx"), "utf8"), privacy = await fs.readFile(path.join(source, "app/privacy/page.tsx"), "utf8");
  const patch = await adapter.prepareSupportPatch(root, source); upgrade.validatePatch(patch);
  assert.equal(patch.files.length, 5);
  assert.ok(patch.files.find(f => f.path.endsWith("Footer.tsx")).contents.includes('<SupportEmail className="vates-footer-support-email" />'));
  const nextPrivacy = patch.files.find(f => f.path === "app/privacy/page.tsx").contents;
  assert.equal(nextPrivacy.split("__CORE_SUPPORT_EMAIL__").length - 1, 3); assert.equal(nextPrivacy.split("<SupportText").length - 1, 3);
  assert.ok(nextPrivacy.includes("ООО Чайная Артель")); assert.ok(nextPrivacy.includes("https://tea-hub.ru/tasks?tab=edu"));
  assert.equal(await fs.readFile(path.join(source, "app/components/Footer.tsx"), "utf8"), footer); assert.equal(await fs.readFile(path.join(source, "app/privacy/page.tsx"), "utf8"), privacy);
  assert.equal(nextPrivacy.includes("teacoffe@yandex.ru"), false);
  assert.throws(() => adapter.adaptSupportSource(footer.replace("vates-footer-support-email", "unknown-contact"), "footer"), /CONTRACT/);
});

test("contact preparation does not touch the live source/build; activation and rollback restore them exactly", async t => {
  const f = await fixture(t), original = await fs.readFile(path.join(f.app, "app/components/Footer.tsx"), "utf8");
  const prepared = await upgrade.prepareContact(f.e, f.patch, f.options);
  assert.equal(await fs.readFile(path.join(f.app, ".next/BUILD_ID"), "utf8"), "old-build"); assert.equal(f.calls.length, 0);
  await upgrade.activateContact(f.e, prepared); assert.equal(await fs.readFile(path.join(f.app, ".next/BUILD_ID"), "utf8"), "new-build");
  assert.notEqual(await fs.readFile(path.join(f.app, "app/components/Footer.tsx"), "utf8"), original);
  await upgrade.restoreContact(f.e, prepared); await upgrade.cleanupContact(f.e, prepared, false);
  assert.equal(await fs.readFile(path.join(f.app, ".next/BUILD_ID"), "utf8"), "old-build"); assert.equal(await fs.readFile(path.join(f.app, "app/components/Footer.tsx"), "utf8"), original);
  await assert.rejects(fs.stat(path.join(f.app, "app/components/CoreSupportContact.tsx")), { code: "ENOENT" });
  assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith(".contact-")), false);
});

test("a failed contact build leaves the working source, build and web service untouched", async t => {
  const f = await fixture(t);
  await assert.rejects(upgrade.prepareContact(f.e, f.patch, { ...f.options, build: async () => { throw Error("Synthetic compile failure"); } }), /MAIL_CONTACT_BUILD_FAILED/);
  assert.equal(f.calls.length, 0); assert.equal(await fs.readFile(path.join(f.app, ".next/BUILD_ID"), "utf8"), "old-build");
  assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith(".contact-")), false);
});

test("modified live source or build is refused rather than overwritten", async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.app, "app/components/Footer.tsx"), "\n// owner edit\n");
  await assert.rejects(upgrade.prepareContact(f.e, f.patch, f.options), /MAIL_CONTACT_SOURCE_CHANGED/); assert.equal(f.calls.length, 0);
  await fs.copyFile(path.join(source, "app/components/Footer.tsx"), path.join(f.app, "app/components/Footer.tsx"));
  const prepared = await upgrade.prepareContact(f.e, f.patch, f.options); await fs.writeFile(path.join(f.app, ".next/BUILD_ID"), "owner-new-build");
  await assert.rejects(upgrade.activateContact(f.e, prepared), /MAIL_CONTACT_BUILD_CHANGED/);
  await upgrade.cleanupContact(f.e, prepared, false); assert.equal(await fs.readFile(path.join(f.app, ".next/BUILD_ID"), "utf8"), "owner-new-build");
});

test("an already adapted and responding site does not rebuild on later address changes", async t => {
  const f = await fixture(t), first = await upgrade.prepareContact(f.e, f.patch, f.options);
  await upgrade.activateContact(f.e, first); await upgrade.cleanupContact(f.e, first, true);
  const next = await upgrade.prepareContact({ ...f.e, c: { ...f.e.c, operationId: crypto.randomUUID() } }, f.patch, { ...f.options, build: async () => assert.fail("Must not rebuild") });
  assert.equal(next.existing, true); assert.equal(next.buildPerformed, false);
});

test("the public contact probe rejects secrets, arbitrary strings, redirects and malformed payloads", async () => {
  for (const body of [{ protocol: "lms-core-support-contact-v1", supportEmail: "support@example.invalid", SMTP_PASS: "must-not-escape" }, { protocol: "lms-core-support-contact-v1", supportEmail: "javascript:evil" }, { protocol: "other", supportEmail: "a@example.invalid" }]) {
    const result = await upgrade.probeContact({ c: { webPort: 1 } }, async () => ({ ok: true, text: async () => JSON.stringify(body) }));
    assert.deepEqual(result, { supportContactReady: false }); assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  }
});
