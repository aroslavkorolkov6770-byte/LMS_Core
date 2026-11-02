const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { InstallationPackageService, verifyInstallerVersions } = require("../dist/installation-package.js");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-package-diagnostic-"));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("core-package-diagnostic-")); await fs.rm(root, { recursive: true }); });
  const snapshotId = randomUUID(), revision = "a".repeat(40), sourceId = randomUUID();
  const service = new InstallationPackageService(root, { verifySnapshot: async id => { assert.equal(id, snapshotId); return { revision }; } });
  const candidate = async (overrides = {}) => {
    const directory = path.join(root, "infra/runtime/runtime-adapted-sources", sourceId), acceptance = path.join(root, "infra/runtime/local-acceptance", sourceId);
    await fs.mkdir(directory, { recursive: true }); await fs.mkdir(acceptance, { recursive: true });
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ snapshotId, revision, contentMode: "empty", adapterVersion: 3, ...overrides }));
    await fs.writeFile(path.join(acceptance, "acceptance.json"), JSON.stringify({ sourceId, revision, restrictedDatabaseRole: true }));
  };
  return { root, snapshotId, revision, sourceId, service, candidate };
}
test("unprepared source including missing cache gets actionable local-not-SSH error", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepare(f.snapshotId), error => error.message.includes(f.revision.slice(0, 12)) && error.message.includes("не ошибка SSH") && !error.message.includes("ENOENT"));
});
test("accepted source for a different Git revision is never used as fallback", async t => {
  const f = await fixture(t); await f.candidate({ revision: "b".repeat(40) });
  await assert.rejects(f.service.prepare(f.snapshotId), /Старый код вместо выбранного не используется/);
});
test("support contract failure exposes fixed code, not raw subprocess data", async t => {
  const f = await fixture(t); await f.candidate(); await fs.mkdir(path.join(f.root, "infra/scripts"));
  await fs.writeFile(path.join(f.root, "infra/scripts/build-lms-installation.cjs"), 'process.stderr.write("Installation package failed: SUPPORT_SOURCE_CONTRACT_CHANGED\\nprivate-fixture-should-not-leak");process.exitCode=1;');
  await assert.rejects(f.service.prepare(f.snapshotId), error => error.message.includes("SUPPORT_SOURCE_CONTRACT_CHANGED") && error.message.includes("структура контактов") && !error.message.includes("private-fixture"));
});
test("unknown build failure does not leak arbitrary stderr into the operator message", async t => {
  const f = await fixture(t); await f.candidate(); await fs.mkdir(path.join(f.root, "infra/scripts"));
  await fs.writeFile(path.join(f.root, "infra/scripts/build-lms-installation.cjs"), 'process.stderr.write("arbitrary-private-output");process.exitCode=1;');
  await assert.rejects(f.service.prepare(f.snapshotId), error => error.message.includes("PACKAGE_BUILD_FAILED") && !error.message.includes("arbitrary-private"));
});
test("new Git source is prepared automatically once, then still goes through package verification", async t => {
  const f = await fixture(t); let prepared = 0, verified = 0;
  f.service.prepareSource = async id => {
    assert.equal(id, f.snapshotId); prepared++; await f.candidate();
    await fs.mkdir(path.join(f.root, "infra/scripts"));
    await fs.writeFile(path.join(f.root, "infra/scripts/build-lms-installation.cjs"), `process.stdout.write(${JSON.stringify(JSON.stringify({ id: randomUUID(), sourceId: f.sourceId, revision: f.revision, sha256: "b".repeat(64), archiveBytes: 123 }))});`);
  };
  f.service.verify = async (pkg, id) => { assert.equal(id, f.snapshotId); assert.equal(pkg.sourceId, f.sourceId); verified++; return pkg; };
  assert.equal((await f.service.prepare(f.snapshotId)).revision, f.revision);
  assert.equal(prepared, 1); assert.equal(verified, 1);
  await f.service.prepare(f.snapshotId); assert.equal(prepared, 1); assert.equal(verified, 2);
});
test("automatic preparation never spins forever or accepts a source without a receipt", async t => {
  const f = await fixture(t); let attempts = 0;
  f.service.prepareSource = async () => { attempts++; };
  await assert.rejects(f.service.prepare(f.snapshotId), /ещё не завершена/); assert.equal(attempts, 1);
});

test("stale installer modules are rejected locally with a single rebuild instruction, before SSH", async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, "infra/scripts"), { recursive: true });
  const files = [], names = ["lms-install-job.cjs", "lms-new-install-worker.cjs", "runtime-process.cjs", "source-curriculum.cjs"];
  for (const name of names) {
    const bytes = Buffer.from("isolated module " + name); await fs.writeFile(path.join(f.root, "infra/scripts", name), bytes);
    files.push({ path: "installer/" + name, sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex") });
  }
  await verifyInstallerVersions(f.root, files);
  for (const file of files) {
    await assert.rejects(verifyInstallerVersions(f.root, files.map(entry => entry === file ? { ...entry, sha256: "0".repeat(64) } : entry)), /Нажмите только «2\. Собрать пакет»/);
  }
  await assert.rejects(verifyInstallerVersions(f.root, files.slice(0, -1)), /сервер не изменён/);
});
