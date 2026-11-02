"use strict";
const fs = require("node:fs/promises");
const constants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");
const { parseEnv } = require("node:util");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const KEYS = ["AI_API_KEY", "AI_PROJECT_ID", "AI_PROMPT_ID", "AI_VECTOR_STORE_ID"];
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const demand = (condition, code) => { if (!condition) fail(code); };
const AI_PROFILE = { keys: KEYS, normalize: normalizeSettings, state: publicState,
  capability: { file: "app/lib/aliceAi.ts", required: [...KEYS, "getAliceAiConfig"] }, encode: value => value };

function normalizeSettings(input, previous = {}) {
  demand(input && typeof input === "object" && !Array.isArray(input), "AI_SETTINGS_INVALID");
  const values = {};
  for (const key of KEYS) {
    const raw = input[key] === undefined || key === "AI_API_KEY" && input[key] === "" ? previous[key] : input[key];
    demand(typeof raw === "string", key === "AI_API_KEY" ? "AI_TOKEN_REQUIRED" : "AI_IDS_REQUIRED");
    const value = raw.trim();
    demand(key === "AI_API_KEY" ? /^[A-Za-z0-9_./~+%=:!-]{1,8192}$/.test(value) : /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value), key === "AI_API_KEY" ? "AI_TOKEN_INVALID" : "AI_IDS_INVALID");
    if (key !== "AI_API_KEY") demand(!/^\d+$/.test(value), "AI_IDS_PLACEHOLDER");
    values[key] = value;
  }
  return values;
}

// Preserve unrelated assignments verbatim, including quoted multiline values.
function upsertEnv(contents, settings, clientId, keys = KEYS, encode = value => value) {
  const lines = contents.match(/[^\n]*\n|[^\n]+$/g) || [];
  let quote = null, keep = true, preserved = "";
  for (const line of lines) {
    let value = line;
    if (!quote) {
      const assignment = /^\s*(?:export\s+)?([\w.-]+)\s*(?:=\s*|:\s+)(.*)/.exec(line);
      keep = !assignment || !keys.includes(assignment[1]);
      if (assignment) {
        value = assignment[2].trimStart();
        quote = ["'", '"', "`"].includes(value[0]) ? value[0] : null;
        value = quote ? value.slice(1) : "";
      } else value = "";
    }
    if (quote) {
      for (let index = 0; index < value.length; index++) {
        if (value[index] !== quote) continue;
        let escapes = 0; for (let previous = index - 1; previous >= 0 && value[previous] === "\\"; previous--) escapes++;
        if (escapes % 2 === 0) { quote = null; break; }
      }
    }
    if (keep) preserved += line;
  }
  demand(!quote, "AI_ENV_FORMAT_UNSUPPORTED");
  const marker = `# LMS Core AI client:${clientId}`;
  const prefix = preserved.startsWith(marker + "\n") ? "" : marker + "\n";
  return prefix + preserved + (preserved.endsWith("\n") || !preserved ? "" : "\n") + keys.map(key => `${key}=${encode(settings[key])}`).join("\n") + "\n";
}

function validateTarget(input) {
  demand(input && ["clientId", "jobId", "releaseId"].every(key => UUID.test(input[key])) && /^\/(?:[a-z0-9_-][a-z0-9_.-]*\/)+[a-z0-9_-][a-z0-9_.-]*$/i.test(input.appPath || "") && !input.appPath.includes(".."), "AI_TARGET_INVALID");
  demand(Number.isInteger(input.webPort) && input.webPort >= 1024 && input.webPort <= 65535 && (input.operationId === undefined || UUID.test(input.operationId)), "AI_TARGET_INVALID");
  return Object.fromEntries(["clientId", "jobId", "releaseId", "appPath", "webPort", "operationId"].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
}

async function environment(input, options = {}) {
  const c = validateTarget(input);
  const profile = options.profile || AI_PROFILE;
  demand(options.fixture || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const disk = name => options.root ? path.join(options.root, name) : name;
  const run = options.run || (async (file, args) => (await execFile(file, args, { timeout: 45000, maxBuffer: 65536, windowsHide: true })).stdout);
  const user = `lms-${crypto.createHash("sha256").update(c.clientId).digest("hex").slice(0, 20)}`;
  const account = options.account || { uid: Number((await run("id", ["-u", user])).trim()), gid: Number((await run("id", ["-g", user])).trim()) };
  demand(Number.isInteger(account.uid) && Number.isInteger(account.gid), "AI_SERVICE_ACCOUNT_INVALID");
  async function directory(file, appOwned = false) {
    if (options.root && file === path.resolve(options.root)) return;
    const parent = path.dirname(file); if (parent !== file) await directory(parent, appOwned);
    const stat = await fs.lstat(file);
    demand(stat.isDirectory() && !stat.isSymbolicLink() && (options.fixture || !(stat.mode & 0o022) && (stat.uid === 0 || appOwned && stat.uid === account.uid)), "AI_PATH_UNSAFE");
  }
  async function regular(file, appOwned = false) {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      demand(stat.isFile() && stat.nlink === 1 && stat.size <= 256 * 1024 && (options.fixture || !(stat.mode & 0o022) && (stat.uid === 0 || appOwned && stat.uid === account.uid)), "AI_FILE_UNSAFE");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }
  const root = disk(c.appPath), release = path.join(root, "releases", c.releaseId), shared = path.join(root, "shared");
  await directory(root); await directory(release); await directory(shared);
  const owner = JSON.parse(await regular(path.join(root, ".core-install-owner.json")));
  const context = JSON.parse(await regular(path.join(shared, "runtime-context.json")));
  demand(owner.state === "installed" && owner.clientId === c.clientId && owner.jobId === c.jobId && owner.releaseId === c.releaseId && context.clientId === c.clientId && context.releaseId === c.releaseId && context.releaseRoot === path.posix.join(c.appPath, "releases", c.releaseId) && context.webPort === c.webPort, "AI_OWNER_MISMATCH");
  demand(await fs.realpath(path.join(root, "current")) === await fs.realpath(release), "AI_RELEASE_MISMATCH");
  const app = path.join(release, "lms"); await directory(app, true);
  const capability = await regular(path.join(app, profile.capability.file), true);
  demand(profile.capability.required.every(key => capability.includes(key)), "AI_SOURCE_UNSUPPORTED");
  const unit = `lms-${path.basename(c.appPath)}-web.service`;
  demand(Array.isArray(owner.services) && owner.services.includes(unit), "AI_SERVICE_MISMATCH");
  const unitFile = await regular(disk(`/etc/systemd/system/${unit}`));
  demand(unitFile.split(/\r?\n/).includes(`User=${user}`) && unitFile.includes(` ${path.posix.join(c.appPath, "releases", c.releaseId, "backend/runtime-process.cjs")} ${path.posix.join(c.appPath, "shared/runtime-context.json")} web\n`), "AI_SERVICE_MISMATCH");
  const managed = path.join(shared, "ai.env"), link = path.join(app, ".env.production.local");
  async function optional(file, appOwned = false, allowManagedLink = false) {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        demand(allowManagedLink && path.resolve(path.dirname(file), await fs.readlink(file)) === path.resolve(managed), "AI_ENV_LINK_UNSAFE");
        return await regular(managed);
      }
      return await regular(file, appOwned);
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  const effective = {}, rawEffective = {};
  for (const name of [".env.production.local", ".env.local", ".env.production", ".env"]) {
    const text = await optional(path.join(app, name), true, name === ".env.production.local");
    if (text === null) continue;
    const parsed = parseEnv(text);
    for (const key of [...profile.keys, "YANDEX_PROJECT_ID", "YANDEX_PROMPT_ID", "YANDEX_VECTOR_STORE_ID"]) {
      if (effective[key] === undefined && parsed[key] !== undefined) { rawEffective[key] = parsed[key]; effective[key] = profile.decode ? profile.decode(parsed[key]) : parsed[key]; }
    }
  }
  for (const name of ["PROJECT_ID", "PROMPT_ID", "VECTOR_STORE_ID"]) effective[`AI_${name}`] ??= effective[`YANDEX_${name}`];
  for (const [key, value] of Object.entries(profile.defaults || {})) if (!effective[key]) effective[key] = value;
  async function health() {
    await run("systemctl", ["is-active", "--quiet", unit]);
    const response = await (options.fetch || fetch)(`http://127.0.0.1:${c.webPort}/api/core-runtime/health`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const value = await response.json();
    demand(response.ok && value.protocol === "lms-core-client-v1" && value.status === "ok" && value.clientId === c.clientId && value.releaseId === c.releaseId, "AI_LMS_HEALTH_FAILED");
  }
  async function atomic(file, text) {
    const temporary = file + "." + crypto.randomUUID() + ".tmp";
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(text); await handle.sync();
      if (!options.fixture) await handle.chown(0, account.gid);
      await handle.chmod(0o640); await handle.close(); handle = null;
      await fs.rename(temporary, file);
    } finally { if (handle) await handle.close(); await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  return { c, root, shared, app, unit, user, account, profile, managed, link, effective, rawEffective, run, health, regular, optional, atomic };
}

function publicState(e, phase, fields, extra = {}) {
  const ids = Object.fromEntries(KEYS.slice(1).map(key => [key, typeof fields[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(fields[key]) ? fields[key] : ""]));
  return { clientId: e.c.clientId, jobId: e.c.jobId, releaseId: e.c.releaseId, operationId: e.c.operationId, phase, apiKeyPresent: Boolean(fields.AI_API_KEY), ...ids,
    configured: Boolean(fields.AI_API_KEY && Object.values(ids).every(value => value && !/^\d+$/.test(value))), envFile: path.posix.join(e.c.appPath, "releases", e.c.releaseId, "lms/.env.production.local"), updatedAt: new Date().toISOString(), providerVerified: false, ...extra };
}

async function inspectAi(input, options = {}) {
  const e = await environment(input, options); await e.health();
  return e.profile.state(e, "checked", e.effective);
}

async function configureAi(input, settings, options = {}) {
  let e = await environment(input, options), values;
  demand(UUID.test(e.c.operationId), "AI_TARGET_INVALID");
  const lockPath = path.join(e.shared, "ai-configuration.lock"), backup = path.join(e.shared, `.ai-original-${e.c.operationId}`);
  let lock, changed = false, moved = false, linked = false, oldLink = false, previous = null, original = null, prepared, committed = false;
  async function waitHealthy(attempts) {
    const deadline = Date.now() + 45000;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { await e.health(); return true; } catch {
        if (attempt + 1 === attempts || Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1000));
      }
    }
    return false;
  }
  try { lock = await fs.open(lockPath, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") fail("AI_CONFIGURATION_BUSY"); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ operationId: e.c.operationId, pid: process.pid }));
    // Re-read after acquiring the server lock so a previous configuration cannot be overwritten from a stale snapshot.
    e = await environment(input, options); values = e.profile.normalize(settings, e.effective, e);
    if (options.prepare) {
      prepared = await options.prepare(e);
      e = await environment(input, options); values = e.profile.normalize(settings, e.effective, e);
    }
    previous = await e.optional(e.managed);
    if (previous !== null) demand(previous.startsWith(`# LMS Core AI client:${e.c.clientId}\n`), "AI_ENV_OCCUPIED");
    const current = await fs.lstat(e.link).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    oldLink = current?.isSymbolicLink() === true; linked = oldLink;
    original = current && !oldLink ? await e.regular(e.link, true) : null;
    const contents = upsertEnv(previous ?? original ?? "", values, e.c.clientId, e.profile.keys, e.profile.encode);
    await e.health();
    if (original !== null) {
      await fs.rename(e.link, backup); moved = true;
      demand(await e.regular(backup, true) === original, "AI_ENV_CHANGED");
    }
    await e.atomic(e.managed, contents); changed = true;
    if (!oldLink) { await fs.symlink(e.managed, e.link); linked = true; }
    if (options.activate) await options.activate(e, prepared);
    await e.run("systemctl", ["restart", e.unit]);
    demand(await waitHealthy(options.attempts || 20), "AI_LMS_HEALTH_FAILED");
    const extra = options.verify ? await options.verify(e, values, prepared) : {};
    if (options.commit) await options.commit(e, prepared);
    if (moved) await fs.unlink(backup);
    committed = true;
    return e.profile.state(e, "applied", values, { restarted: true, ...extra });
  } catch (error) {
    if (!changed && !moved) return e.profile.state(e, "failed", e.effective, { errorCode: /^(?:AI|MAIL)_[A-Z_]+$/.test(error.code || "") ? error.code : "AI_CHANGE_NOT_APPLIED", rollbackRestored: true });
    let restored = false;
    try {
      if (options.rollback) await options.rollback(e, prepared);
      if (!oldLink && linked) { demand((await fs.lstat(e.link)).isSymbolicLink() && await fs.readlink(e.link) === e.managed, "AI_ENV_CHANGED"); await fs.unlink(e.link); }
      if (previous !== null && changed) await e.atomic(e.managed, previous);
      else if (changed) await fs.unlink(e.managed);
      if (moved) { demand(!await fs.lstat(e.link).catch(error => { if (error.code === "ENOENT") return null; throw error; }), "AI_ENV_CHANGED"); await fs.rename(backup, e.link); }
      await e.run("systemctl", ["restart", e.unit]); restored = await waitHealthy(options.rollbackAttempts || 20);
    } catch { /* Keep the protected original if rollback cannot be confirmed. */ }
    return e.profile.state(e, restored ? "failed" : "needs_attention", restored ? e.effective : {}, { errorCode: restored ? "AI_CHANGE_ROLLED_BACK" : "AI_ROLLBACK_UNCONFIRMED", rollbackRestored: restored });
  } finally {
    try { if (options.cleanup) await options.cleanup(e, prepared, committed); }
    finally { try { await lock.close(); await fs.unlink(lockPath); } finally { if (values) for (const key of e.profile.keys) delete values[key]; } }
  }
}

module.exports = { normalizeSettings, upsertEnv, validateTarget, inspectAi, configureAi, environment };
