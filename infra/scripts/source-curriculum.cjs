"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const demand = (value, code) => { if (!value) throw Object.assign(Error(code), { code }); };
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const KEYS = ["core_lms_route_v1", "core_lms_tests_v1"];

function validateItems(value, tests = false) {
  demand(Array.isArray(value) && value.length <= 5000, "CURRICULUM_ARRAY_INVALID");
  const ids = new Set();
  for (const item of value) {
    demand(item && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string" && /^[a-z0-9_.:-]{1,120}$/i.test(item.id) &&
      typeof item.title === "string" && item.title.trim() && item.title.length <= 1000 && !ids.has(item.id), "CURRICULUM_ITEM_INVALID");
    ids.add(item.id);
    if (tests) {
      demand(Array.isArray(item.quiz) && item.quiz.length > 0 && item.quiz.length <= 1000, "CURRICULUM_QUIZ_INVALID");
      for (const q of item.quiz) demand(q && typeof q.q === "string" && q.q.trim() && Array.isArray(q.o) && q.o.length >= 2 && q.o.every(s => typeof s === "string") &&
        Number.isInteger(q.c) && q.c >= 0 && q.c < q.o.length, "CURRICULUM_ANSWER_INVALID");
    }
  }
  demand(Buffer.byteLength(JSON.stringify(value)) <= 5 * 1024 * 1024, "CURRICULUM_TOO_LARGE");
  return value;
}

// Read literals only. Git TypeScript is untrusted input and must never be evaluated or imported.
function readTrainingLiteral(source, ts) {
  const file = ts.createSourceFile("defaultTrainingTests.ts", source, ts.ScriptTarget.Latest, true);
  demand(file.parseDiagnostics.length === 0, "CURRICULUM_TYPESCRIPT_INVALID");
  const matches = [];
  for (const statement of file.statements) if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) {
    if (ts.isIdentifier(d.name) && d.name.text === "DEFAULT_TRAINING_TESTS") matches.push(d.initializer);
  }
  demand(matches.length === 1 && matches[0], "CURRICULUM_EXPORT_INVALID");
  function literal(node, depth = 0) {
    demand(node && depth < 30, "CURRICULUM_LITERAL_INVALID");
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, depth + 1);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(n => literal(n, depth + 1));
    if (ts.isObjectLiteralExpression(node)) {
      const entries = [], names = new Set();
      for (const p of node.properties) {
        demand(ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)), "CURRICULUM_LITERAL_INVALID");
        const name = p.name.text;
        demand(!["__proto__", "prototype", "constructor"].includes(name) && !names.has(name), "CURRICULUM_LITERAL_INVALID");
        names.add(name); entries.push([name, literal(p.initializer, depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    demand(false, "CURRICULUM_LITERAL_INVALID");
  }
  return validateItems(literal(matches[0]), true);
}

async function parseSourceCurriculum(read, ts) {
  let lessons = [];
  try { lessons = validateItems(JSON.parse(await read("data/tea_hub_dynamic_route_v2.json"))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let tests = readTrainingLiteral(await read("app/tasks/data/defaultTrainingTests.ts"), ts);
  try {
    const dynamic = validateItems(JSON.parse(await read("data/tea_hub_dynamic_tests_v1.json")), true);
    tests = mergeCurriculum(tests, dynamic, true).data;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { version: 1, entries: [{ key: KEYS[0], data: lessons }, { key: KEYS[1], data: tests }] };
}

async function readSourceCurriculum(directory, ts) {
  return parseSourceCurriculum(file => fs.readFile(path.join(directory, file), "utf8"), ts);
}

async function readGitCurriculum(gitDirectory, revision, git, ts) {
  demand(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision), "CURRICULUM_SOURCE_INVALID");
  const run = require("node:util").promisify(require("node:child_process").execFile);
  const settings = { windowsHide: true, timeout: 30000, maxBuffer: 6 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" } };
  const names = ["data/tea_hub_dynamic_route_v2.json", "data/tea_hub_dynamic_tests_v1.json", "app/tasks/data/defaultTrainingTests.ts"];
  const list = (await run(git, ["--git-dir", gitDirectory, "ls-tree", "-r", "--name-only", revision, "--", ...names], settings)).stdout.trim().split(/\r?\n/);
  const value = await parseSourceCurriculum(async file => {
    demand(names.includes(file), "CURRICULUM_FILE_INVALID");
    if (!list.includes(file)) throw Object.assign(Error("Missing teaching file"), { code: "ENOENT" });
    return (await run(git, ["--git-dir", gitDirectory, "show", `${revision}:${file}`], settings)).stdout;
  }, ts);
  return { ...value, revision };
}

function curriculumSummary(bundle) {
  demand(bundle && bundle.version === 1 && Object.keys(bundle).every(key => ["version", "revision", "entries"].includes(key)) &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(bundle.revision || "") && Array.isArray(bundle.entries) && bundle.entries.length === 2 &&
    bundle.entries.every((entry, i) => entry && Object.keys(entry).every(key => ["key", "data"].includes(key)) && entry.key === KEYS[i]), "CURRICULUM_BUNDLE_INVALID");
  validateItems(bundle.entries[0].data); validateItems(bundle.entries[1].data, true);
  return { revision: bundle.revision, sha256: hash(bundle), topics: bundle.entries[0].data.length, tests: bundle.entries[1].data.length,
    questions: bundle.entries[1].data.reduce((count, test) => count + test.quiz.length, 0) };
}

// First-install only: never overwrite nonempty customer data, even if a caller accidentally repeats bootstrap.
async function initializeCurriculum({ mode, bundle, apiPort, serviceToken, write = false }, options = {}) {
  demand(["empty", "source"].includes(mode) && Number.isInteger(apiPort) && apiPort >= 1024 && apiPort <= 65535 && /^[A-Za-z0-9_-]{43,256}$/.test(serviceToken || ""), "CURRICULUM_INSTALL_CONFIG_INVALID");
  const summary = mode === "source" ? curriculumSummary(bundle) : { topics: 0, tests: 0, questions: 0 };
  const wanted = mode === "source" ? bundle.entries : KEYS.map(key => ({ key, data: [] }));
  const request = async (action, body) => {
    let response;
    try { response = await (options.fetch || fetch)(`http://127.0.0.1:${apiPort}/api/lms-runtime/v1/${action}`, {
      method: action === "write" ? "PUT" : "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceToken}` }, body: JSON.stringify(body)
    }); } catch { demand(false, "CURRICULUM_INSTALL_CONNECTION_FAILED"); }
    demand(response.ok, response.status === 409 ? "CURRICULUM_REVISION_CONFLICT" : "CURRICULUM_RUNTIME_FAILED");
    let value; try { value = await response.json(); } catch { demand(false, "CURRICULUM_PROTOCOL_INVALID"); }
    demand(value?.protocol === "lms-core-runtime-v1", "CURRICULUM_PROTOCOL_INVALID"); return value;
  };
  const read = async () => {
    const value = await request("read", { keys: [...KEYS, "core_lms_users_v1"] });
    demand(Array.isArray(value.entries) && value.entries.length === 3 && new Set(value.entries.map(entry => entry.key)).size === 3, "CURRICULUM_READ_INVALID");
    const entries = new Map(value.entries.map(entry => [entry.key, entry]));
    for (const key of [...KEYS, "core_lms_users_v1"]) {
      const row = entries.get(key);
      demand(row && typeof row.found === "boolean" && Number.isInteger(row.revision) && row.revision >= 0, "CURRICULUM_READ_INVALID");
    }
    demand(entries.get("core_lms_users_v1").found && Array.isArray(entries.get("core_lms_users_v1").data), "CURRICULUM_USERS_UNAVAILABLE");
    return entries;
  };
  const before = await read(), pending = [];
  for (const expected of wanted) {
    const current = before.get(expected.key), data = current.found ? current.data : [];
    demand(Array.isArray(data), "CURRICULUM_EXISTING_DATA_CONFLICT");
    if (hash(data) === hash(expected.data)) continue;
    demand(write && mode === "source" && data.length === 0, "CURRICULUM_INSTALL_VERIFY_FAILED");
    pending.push({ key: expected.key, data: expected.data, expectedRevision: current.revision });
  }
  // All collections are preflighted before the first write. Each write still uses the actual CAS revision.
  for (const input of pending) {
    const result = await request("write", input);
    demand(result.key === input.key && result.revision === input.expectedRevision + 1, "CURRICULUM_WRITE_UNCONFIRMED");
  }
  const after = await read();
  for (const expected of wanted) {
    const current = after.get(expected.key);
    demand(hash(current.found ? current.data : []) === hash(expected.data), "CURRICULUM_INSTALL_VERIFY_FAILED");
  }
  const usersBefore = before.get("core_lms_users_v1"), usersAfter = after.get("core_lms_users_v1");
  demand(usersBefore.revision === usersAfter.revision && hash(usersBefore.data) === hash(usersAfter.data), "CURRICULUM_USERS_CHANGED");
  return { mode, ...summary, verified: true, writtenCollections: pending.length, usersUnchanged: true };
}

function mergeCurriculum(current, incoming, tests = false) {
  const before = current === null || current === undefined ? [] : validateItems(current, tests);
  validateItems(incoming, tests);
  const byId = new Map(before.map(item => [item.id, item])), added = [], conflicts = [];
  const stable = value => JSON.stringify(value, (key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  for (const item of incoming) {
    if (!byId.has(item.id)) added.push(item);
    else if (stable(byId.get(item.id)) !== stable(item)) conflicts.push(item.id);
  }
  demand(conflicts.length === 0, "CURRICULUM_EXISTING_EDITS_CONFLICT");
  return { data: [...before, ...added], added: added.length, existing: before.length, unchanged: incoming.length - added.length };
}

async function recoverSourceCurriculum(target, bundle, options = {}) {
  demand(bundle?.version === 1 && Array.isArray(bundle.entries) && bundle.entries.length === 2 && bundle.entries.every((v, i) => v.key === KEYS[i]), "CURRICULUM_BUNDLE_INVALID");
  bundle.entries.forEach((v, i) => validateItems(v.data, i === 1));
  demand(/^[a-f0-9]{40}$/.test(bundle.revision || ""), "CURRICULUM_SOURCE_INVALID");
  const profile = { keys: [], capability: { file: "app/api/core-runtime/health/route.ts", required: ["lms-core-client-v1", "postgresql-runtime"] } };
  const e = await (options.environment || require("./configure-lms-ai.cjs").environment)(target, { ...options, profile });
  await e.health();
  const context = JSON.parse(await e.regular(path.join(e.shared, "runtime-context.json")));
  demand(context.clientId === e.c.clientId && context.releaseId === e.c.releaseId && Number.isInteger(context.apiPort) && context.apiPort > 1024 && context.apiPort < 65536, "CURRICULUM_CONTEXT_INVALID");
  let credentials;
  if (options.fixture) credentials = options.credentials;
  else {
    const keyFile = path.join(e.shared, "runtime-vault.key"), stat = await fs.lstat(keyFile);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 0 && !(stat.mode & 0o027) && stat.size === 32, "CURRICULUM_VAULT_UNSAFE");
    const open = options.unseal || require("./runtime-process.cjs").openSecrets;
    credentials = open(JSON.parse(await e.regular(path.join(e.shared, "runtime-vault.json"))), await fs.readFile(keyFile), e.c.clientId);
  }
  demand(/^[A-Za-z0-9_-]{43,256}$/.test(credentials?.serviceToken || ""), "CURRICULUM_ACCESS_UNAVAILABLE");
  const request = async (action, body) => {
    const response = await (options.fetch || fetch)(`http://127.0.0.1:${context.apiPort}/api/lms-runtime/v1/${action}`, {
      method: action === "write" ? "PUT" : "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.serviceToken}` }, body: JSON.stringify(body)
    });
    demand(response.ok, response.status === 409 ? "CURRICULUM_REVISION_CONFLICT" : "CURRICULUM_RUNTIME_FAILED");
    const value = await response.json(); demand(value.protocol === "lms-core-runtime-v1", "CURRICULUM_PROTOCOL_INVALID"); return value;
  };
  let lock;
  const lockFile = path.join(e.shared, "ai-configuration.lock");
  try {
    if (options.apply) lock = await fs.open(lockFile, "wx", 0o600);
    const before = await request("read", { keys: [...KEYS, "core_lms_users_v1"] });
    demand(Array.isArray(before.entries) && before.entries.length === 3, "CURRICULUM_READ_INVALID");
    const entries = new Map(before.entries.map(v => [v.key, v]));
    const plans = bundle.entries.map((v, i) => {
      const existing = entries.get(v.key);
      demand(existing && Number.isInteger(existing.revision) && existing.revision >= 0 && typeof existing.found === "boolean", "CURRICULUM_READ_INVALID");
      return { ...v, before: existing, ...mergeCurriculum(existing.found ? existing.data : null, v.data, i === 1) };
    });
    const users = entries.get("core_lms_users_v1");
    demand(users?.found && Array.isArray(users.data), "CURRICULUM_USERS_UNAVAILABLE");
    const output = { clientId: e.c.clientId, releaseId: e.c.releaseId, revision: bundle.revision, sourceSha256: hash(bundle),
      phase: options.apply ? "applied" : "inspected", updatedAt: new Date().toISOString(),
      entries: plans.map(v => ({ key: v.key, current: v.existing, added: v.added, source: bundle.entries.find(b => b.key === v.key).data.length, total: v.data.length })),
      usersUnchanged: true, backup: null };
    if (!options.apply) return output;
    // The backup stays root-only on this VPS; only teaching content is copied, never accounts or secrets.
    const backup = path.join(e.shared, `curriculum-before-${crypto.randomUUID()}.json`);
    await fs.writeFile(backup, JSON.stringify({ clientId: e.c.clientId, releaseId: e.c.releaseId, revision: bundle.revision,
      entries: KEYS.map(key => entries.get(key)) }), { flag: "wx", mode: 0o600 });
    output.backup = backup;
    for (const plan of plans) if (plan.added) {
      const result = await request("write", { key: plan.key, data: plan.data, expectedRevision: plan.before.revision });
      demand(result.key === plan.key && result.revision === plan.before.revision + 1, "CURRICULUM_WRITE_UNCONFIRMED");
    }
    const after = await request("read", { keys: [...KEYS, "core_lms_users_v1"] });
    demand(Array.isArray(after.entries), "CURRICULUM_READ_INVALID");
    for (const plan of plans) {
      const actual = after.entries.find(v => v.key === plan.key);
      demand(actual?.found && hash(actual.data) === hash(plan.data), "CURRICULUM_VERIFY_FAILED");
    }
    const accounts = after.entries.find(v => v.key === "core_lms_users_v1");
    demand(accounts?.revision === users.revision && hash(accounts.data) === hash(users.data), "CURRICULUM_USERS_CHANGED");
    await e.health();
    const receipt = path.join(e.shared, "curriculum-recovery.json");
    await e.atomic(receipt, JSON.stringify(output)); return output;
  } finally { if (lock) { await lock.close(); await fs.unlink(lockFile); } if (credentials) credentials.serviceToken = ""; }
}

module.exports = { readTrainingLiteral, readSourceCurriculum, readGitCurriculum, curriculumSummary, initializeCurriculum, validateItems, mergeCurriculum, recoverSourceCurriculum };
