const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { RuntimeSourceAdapterService } = require("../dist/runtime-source-adapter.js");
const { emptyPilotTrainingDefaults } = require("../dist/runtime-auth-adapter.js");
test("empty typed training catalogue is kept byte-for-byte; explicit required fields are not weakened", () => {
  const source = "type TrainingTest = { id: string; subtitle: string; theory: string };\nexport const DEFAULT_TRAINING_TESTS: TrainingTest[] = [];\n";
  assert.equal(emptyPilotTrainingDefaults(source), source);
  assert.equal(emptyPilotTrainingDefaults(source.replace("= [];", "= [{id:'fixture',subtitle:'required',theory:'required'}];")), source);
});
const { root: project } = require("./runtime-test-helper.cjs");
const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";

async function fixture(t, extra = {}, validContract = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-runtime-adapter-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("core-runtime-adapter-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const source = path.join(root, "original");
  const originalStore = validContract ? "export const readDataValue = () => {}; export const readDataValues = () => {}; export const writeDataValue = () => {};" : "export const incompatible = true;";
  const files = { "app/lib/storage/dataStore.ts": originalStore, "app/lib/storage/jsonFileStore.ts": "export const readJsonFile = () => {};",
    "app/lib/serverAuth.ts": "const getBootstrapUsers = (): StoredUser[] => { return process.env.BOOTSTRAP_ADMIN_LOGIN && process.env.BOOTSTRAP_ADMIN_PASSWORD ? [] : []; };\nconst getAuthSecret = () => 'fixture-insecure';\nexport const AUTH_COOKIE_NAME = 'fixture';\n// scrypt2\nexport const authUnchanged = true;",
    "app/tasks/data/defaultTrainingTests.ts": "export const DEFAULT_TRAINING_TESTS = [{ id: 'fixture', title: 'Do not seed', quiz: [] }];",
    "app/page.tsx": "export default function Page() { return null; }", ...extra };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), content);
  }
  await fs.mkdir(path.join(root, "infra"), { recursive: true });
  await fs.cp(path.join(project, "infra/lms-adapter"), path.join(root, "infra/lms-adapter"), { recursive: true });
  const archivePath = path.join(root, "code.tar");
  execFileSync(tar, ["-cf", archivePath, "-C", source, "."], { windowsHide: true, stdio: "pipe" });
  const snapshotId = randomUUID();
  const service = new RuntimeSourceAdapterService(root, { prepare: async (id) => {
    assert.equal(id, snapshotId);
    return { archivePath, revision: "a".repeat(40) };
  } }, tar);
  return { root, service, snapshotId, source, files };
}

test("source adaptation changes only its owned copy and records exact hashes", async (t) => {
  const { service, snapshotId, source, files } = await fixture(t);
  const artifact = await service.prepare(snapshotId);
  assert.equal(artifact.deployed, false);
  assert.equal(artifact.containsBackend, false);
  assert.equal(artifact.database, "postgresql-via-nest-api");
  assert.equal(artifact.modifiedFiles.length, 4);
  assert.equal(artifact.contentMode, "empty");
  assert.equal((await fs.readFile(path.join(artifact.sourcePath, "app/tasks/data/defaultTrainingTests.ts"), "utf8")).includes("Do not seed"), false);
  for (const file of artifact.modifiedFiles) {
    assert.match(file.beforeSha256, /^[a-f0-9]{64}$/);
    assert.match(file.afterSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(file.beforeSha256, file.afterSha256);
  }
  for (const [name, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(source, name), "utf8"), content);
  const auth = await fs.readFile(path.join(artifact.sourcePath, "app/lib/serverAuth.ts"), "utf8");
  assert.match(auth, /authUnchanged = true/);
  assert.match(auth, /core_lms_session_/);
  assert.equal(auth.includes("fixture-insecure"), false);
  assert.equal(auth.includes("BOOTSTRAP_ADMIN_PASSWORD"), false);
  assert.equal(artifact.createdFiles.length, 1);
  assert.match(await fs.readFile(path.join(artifact.sourcePath, "app/lib/storage/dataStore.ts"), "utf8"), /CORE_RUNTIME_API_URL/);
  assert.match(await fs.readFile(path.join(artifact.sourcePath, "app/lib/storage/jsonFileStore.ts"), "utf8"), /Local JSON storage is disabled/);
  assert.deepEqual(JSON.parse(await fs.readFile(artifact.manifestPath, "utf8")), artifact);
});

test("source adaptation refuses storage bypasses and cleans its temporary copy", async (t) => {
  const { root, service, snapshotId } = await fixture(t, { "app/api/bypass.ts": "import { readJsonFile } from '../../lib/storage/jsonFileStore';" });
  await assert.rejects(service.prepare(snapshotId), /обход/);
  assert.deepEqual(await fs.readdir(path.join(root, "infra/runtime/runtime-adapted-sources")), []);
});

test("source adaptation stops on an unknown source contract without editing it", async (t) => {
  const { service, snapshotId, source, files } = await fixture(t, {}, false);
  await assert.rejects(service.prepare(snapshotId), /контракт/);
  assert.equal(await fs.readFile(path.join(source, "app/lib/storage/dataStore.ts"), "utf8"), files["app/lib/storage/dataStore.ts"]);
});
