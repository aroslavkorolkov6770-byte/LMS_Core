const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const ts = require("../node_modules/typescript");
const { readTrainingLiteral, readGitCurriculum, curriculumSummary, initializeCurriculum, mergeCurriculum, recoverSourceCurriculum } = require("../../../infra/scripts/source-curriculum.cjs");
const lesson = { id: "route_1", title: "Original topic", t1: "Original text" };
const quiz = { id: "t_1", title: "Original test", quiz: [{ q: "Question", o: ["One", "Two"], c: 0 }] };
test("Git training is parsed as literal data, never executed; invalid answers and duplicate IDs are rejected", () => {
  assert.deepEqual(readTrainingLiteral(`export const DEFAULT_TRAINING_TESTS = ${JSON.stringify([quiz])} as const;`, ts), [quiz]);
  assert.throws(() => readTrainingLiteral("export const DEFAULT_TRAINING_TESTS = doNotExecute();", ts), /LITERAL/);
  assert.throws(() => readTrainingLiteral("export const DEFAULT_TRAINING_TESTS = [{...globalThis}];", ts), /LITERAL/);
  assert.throws(() => readTrainingLiteral(`export const DEFAULT_TRAINING_TESTS = ${JSON.stringify([{ ...quiz, quiz: [{ q: "Question", o: ["One", "Two"], c: 3 }] }])};`, ts), /ANSWER/);
  assert.throws(() => readTrainingLiteral(`export const DEFAULT_TRAINING_TESTS = ${JSON.stringify([quiz, quiz])};`, ts), /ITEM/);
});
test("curriculum merge preserves existing items, is idempotent and refuses to overwrite edits", () => {
  const own = { id: "custom", title: "Customer material" };
  const result = mergeCurriculum([own], [lesson]);
  assert.deepEqual(result.data, [own, lesson]); assert.equal(result.added, 1);
  assert.equal(mergeCurriculum(result.data, [lesson]).added, 0);
  assert.throws(() => mergeCurriculum([{ ...lesson, t1: "Edited" }], [lesson]), /EXISTING_EDITS_CONFLICT/);
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-curriculum-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-curriculum-")); await fs.rm(root, { recursive: true, force: true }); });
  const clientId = "11111111-1111-4111-8111-111111111111", releaseId = "22222222-2222-4222-8222-222222222222";
  const accounts = [{ id: "admin", login: "keep-private", passHash: "keep-private" }];
  const values = new Map([["core_lms_users_v1", { key: "core_lms_users_v1", revision: 4, found: true, data: accounts }]]);
  const calls = [], mode = { failTests: false };
  const environment = async () => ({ c: { clientId, releaseId }, shared: root, health: async () => {},
    regular: async () => JSON.stringify({ clientId, releaseId, apiPort: 4101 }), atomic: (file, content) => fs.writeFile(file, content, { mode: 0o600 }) });
  const fetch = async (address, options) => {
    assert.ok(address.startsWith("http://127.0.0.1:4101/api/lms-runtime/v1/"));
    assert.equal(options.headers.Authorization, "Bearer " + "f".repeat(43));
    const input = JSON.parse(options.body);
    if (address.endsWith("/read")) return { ok: true, json: async () => ({ protocol: "lms-core-runtime-v1", entries: input.keys.map(key => structuredClone(values.get(key) || { key, found: false, revision: 0, data: null })) }) };
    assert.ok(["core_lms_route_v1", "core_lms_tests_v1"].includes(input.key));
    if (mode.failTests && input.key === "core_lms_tests_v1") return { ok: false, status: 503 };
    calls.push(input);
    const prior = values.get(input.key);
    if ((prior?.revision || 0) !== input.expectedRevision) return { ok: false, status: 409 };
    const row = { key: input.key, found: true, revision: input.expectedRevision + 1, data: structuredClone(input.data) }; values.set(input.key, row);
    return { ok: true, json: async () => ({ protocol: "lms-core-runtime-v1", key: row.key, revision: row.revision }) };
  };
  const bundle = { version: 1, revision: "a".repeat(40), entries: [{ key: "core_lms_route_v1", data: [lesson] }, { key: "core_lms_tests_v1", data: [quiz] }] };
  const options = () => ({ fixture: true, environment, fetch, credentials: { serviceToken: "f".repeat(43) } });
  return { root, clientId, releaseId, accounts, values, calls, mode, bundle, options };
}
test("inspect does not mutate; apply backs up only teaching values and leaves accounts unchanged; repeat does not rewrite", async t => {
  const f = await fixture(t);
  const inspect = await recoverSourceCurriculum({}, f.bundle, f.options());
  assert.equal(inspect.phase, "inspected"); assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readdir(f.root), []);
  const result = await recoverSourceCurriculum({}, f.bundle, { ...f.options(), apply: true });
  assert.equal(result.phase, "applied"); assert.equal(f.calls.length, 2); assert.equal(result.usersUnchanged, true);
  const backup = JSON.parse(await fs.readFile(result.backup, "utf8"));
  assert.equal(backup.entries.length, 2); assert.ok(!JSON.stringify(backup).includes("keep-private"));
  assert.deepEqual(f.values.get("core_lms_users_v1").data, f.accounts); assert.equal(f.values.get("core_lms_users_v1").revision, 4);
  const repeat = await recoverSourceCurriculum({}, f.bundle, { ...f.options(), apply: true });
  assert.equal(f.calls.length, 2); assert.ok(repeat.entries.every(v => v.added === 0));
});
test("existing edit conflicts and foreign keys stop before all writes", async t => {
  const f = await fixture(t);
  f.values.set("core_lms_route_v1", { key: "core_lms_route_v1", found: true, revision: 1, data: [{ ...lesson, t1: "Keep edits" }] });
  await assert.rejects(recoverSourceCurriculum({}, f.bundle, { ...f.options(), apply: true }), /EXISTING_EDITS_CONFLICT/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(recoverSourceCurriculum({}, { ...f.bundle, entries: [{ key: "core_lms_users_v1", data: [] }] }, f.options()), /BUNDLE_INVALID/);
});
test("an interrupted second write can be safely retried without duplicating the first import", async t => {
  const f = await fixture(t); f.mode.failTests = true;
  await assert.rejects(recoverSourceCurriculum({}, f.bundle, { ...f.options(), apply: true }), /RUNTIME_FAILED/);
  assert.equal(f.values.get("core_lms_route_v1").data.length, 1); assert.ok(!f.values.has("core_lms_tests_v1"));
  assert.ok(!JSON.stringify(await fs.readFile(path.join(f.root, (await fs.readdir(f.root)).find(v => v.startsWith("curriculum-before-"))), "utf8")).includes("keep-private"));
  f.mode.failTests = false;
  const result = await recoverSourceCurriculum({}, f.bundle, { ...f.options(), apply: true });
  assert.equal(result.phase, "applied"); assert.equal(f.values.get("core_lms_route_v1").revision, 1); assert.equal(f.values.get("core_lms_tests_v1").revision, 1);
  assert.equal(f.values.get("core_lms_users_v1").revision, 4);
});

test("Git extraction reads committed blobs, excludes accounts and rejects malformed bundle metadata", async t => {
  const f = await fixture(t), gitRoot = path.join(f.root, "git");
  const exec = require("node:util").promisify(require("node:child_process").execFile);
  const git = async (...args) => (await exec("git", args, { cwd: gitRoot, windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } })).stdout.trim();
  await fs.mkdir(gitRoot); await git("init", "--quiet");
  await fs.mkdir(path.join(gitRoot, "data")); await fs.mkdir(path.join(gitRoot, "app/tasks/data"), { recursive: true });
  await fs.writeFile(path.join(gitRoot, "data/tea_hub_dynamic_route_v2.json"), JSON.stringify([lesson]));
  await fs.writeFile(path.join(gitRoot, "data/tea_hub_users_v1.json"), JSON.stringify(f.accounts));
  await fs.writeFile(path.join(gitRoot, "app/tasks/data/defaultTrainingTests.ts"), `export const DEFAULT_TRAINING_TESTS = ${JSON.stringify([quiz])};`);
  await git("add", "."); await git("commit", "--quiet", "-m", "Isolated fixture");
  const revision = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(gitRoot, "data/tea_hub_dynamic_route_v2.json"), "invalid working copy");
  const bundle = await readGitCurriculum(path.join(gitRoot, ".git"), revision, "git", ts);
  assert.deepEqual(bundle.entries.map(entry => entry.data), [[lesson], [quiz]]);
  assert.ok(!JSON.stringify(bundle).includes("keep-private"));
  assert.deepEqual(curriculumSummary(bundle), { revision, sha256: require("node:crypto").createHash("sha256").update(JSON.stringify(bundle)).digest("hex"), topics: 1, tests: 1, questions: 1 });
  assert.throws(() => curriculumSummary({ ...bundle, accounts: [] }), /BUNDLE_INVALID/);
  assert.throws(() => curriculumSummary({ ...bundle, revision: "main" }), /BUNDLE_INVALID/);
  assert.throws(() => curriculumSummary({ ...bundle, entries: [...bundle.entries].reverse() }), /BUNDLE_INVALID/);
});

test("first-install source import verifies both collections and preserves administrator records; retry is idempotent", async t => {
  const f = await fixture(t), input = { mode: "source", bundle: f.bundle, apiPort: 4101, serviceToken: "f".repeat(43), write: true };
  const result = await initializeCurriculum(input, f.options());
  assert.equal(result.verified, true); assert.equal(result.usersUnchanged, true); assert.equal(result.writtenCollections, 2);
  assert.equal((await initializeCurriculum(input, f.options())).writtenCollections, 0); assert.equal(f.calls.length, 2);
  assert.equal(f.values.get("core_lms_users_v1").revision, 4); assert.deepEqual(f.values.get("core_lms_users_v1").data, f.accounts);
  assert.equal((await initializeCurriculum({ ...input, write: false }, f.options())).verified, true);
});

test("first-install preflight checks all collections before writing and never clears nonempty data", async t => {
  const f = await fixture(t), input = { mode: "source", bundle: f.bundle, apiPort: 4101, serviceToken: "f".repeat(43), write: true };
  f.values.set("core_lms_tests_v1", { key: "core_lms_tests_v1", found: true, revision: 2, data: [{ ...quiz, title: "Customer edit" }] });
  await assert.rejects(initializeCurriculum(input, f.options()), /INSTALL_VERIFY_FAILED/); assert.equal(f.calls.length, 0);
  await assert.rejects(initializeCurriculum({ ...input, mode: "empty" }, f.options()), /INSTALL_VERIFY_FAILED/); assert.equal(f.calls.length, 0);
  assert.equal(f.values.get("core_lms_tests_v1").revision, 2);
});

test("empty policy verifies a truly empty teaching database and never writes fallback materials", async t => {
  const f = await fixture(t), input = { mode: "empty", apiPort: 4101, serviceToken: "f".repeat(43), write: true };
  assert.equal((await initializeCurriculum(input, f.options())).topics, 0); assert.equal(f.calls.length, 0);
  f.values.set("core_lms_route_v1", { key: "core_lms_route_v1", found: true, revision: 1, data: [] });
  assert.equal((await initializeCurriculum(input, f.options())).verified, true);
  await assert.rejects(initializeCurriculum({ ...input, mode: "source", bundle: f.bundle, write: false }, f.options()), /INSTALL_VERIFY_FAILED/);
  assert.equal(f.calls.length, 0);
});

test("interrupted first-install import retries only missing data; CAS and account changes cannot report success", async t => {
  const f = await fixture(t), input = { mode: "source", bundle: f.bundle, apiPort: 4101, serviceToken: "f".repeat(43), write: true };
  f.mode.failTests = true;
  await assert.rejects(initializeCurriculum(input, f.options()), /RUNTIME_FAILED/);
  f.mode.failTests = false; assert.equal((await initializeCurriculum(input, f.options())).writtenCollections, 1);
  assert.equal(f.values.get("core_lms_route_v1").revision, 1);
  const fetch = f.options().fetch;
  await assert.rejects(initializeCurriculum(input, { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/read")) f.values.get("core_lms_users_v1").revision++;
    return response;
  } }), /USERS_CHANGED/);
  f.values.delete("core_lms_tests_v1");
  await assert.rejects(initializeCurriculum(input, { fetch: async (url, options) => url.endsWith("/write") ? { ok: false, status: 409 } : fetch(url, options) }), /REVISION_CONFLICT/);
});
