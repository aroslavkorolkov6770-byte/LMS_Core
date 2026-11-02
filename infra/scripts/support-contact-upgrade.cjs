"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { const error = Error(code); error.code = code; throw error; };
const names = ["app/components/Footer.tsx", "app/privacy/page.tsx", "app/components/CoreSupportContact.tsx", "app/api/core-runtime/support-contact/route.ts", "app/lib/core-support-contact-manifest.json"];

function validatePatch(patch) {
  if (patch?.version !== 1 || !Array.isArray(patch.files) || patch.files.length !== names.length || JSON.stringify(patch).length > 512 * 1024 ||
      names.some(name => patch.files.filter(file => file.path === name).length !== 1) || patch.files.some(file => typeof file.contents !== "string" || hash(file.contents) !== file.sha256 || file.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(file.beforeSha256))) fail("MAIL_CONTACT_PATCH_INVALID");
  return patch;
}
async function probeContact(e, fetcher = fetch) {
  try {
    const response = await fetcher(`http://127.0.0.1:${e.c.webPort}/api/core-runtime/support-contact`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const text = await response.text(); if (!response.ok || text.length > 2048) return { supportContactReady: false };
    const value = JSON.parse(text);
    if (value.protocol !== "lms-core-support-contact-v1" || Object.keys(value).sort().join() !== "protocol,supportEmail" || value.supportEmail !== null && (typeof value.supportEmail !== "string" || value.supportEmail.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value.supportEmail))) return { supportContactReady: false };
    return { supportContactReady: true, supportEmail: value.supportEmail || "" };
  } catch { return { supportContactReady: false }; }
}

async function prepareContact(e, patch, options = {}) {
  validatePatch(patch);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(e.c.operationId || "")) fail("MAIL_CONTACT_OPERATION_INVALID");
  const before = new Map(); let alreadyAdapted = true;
  for (const file of patch.files) {
    let contents = null;
    try { contents = await e.regular(path.join(e.app, file.path), true); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const current = contents === null ? null : hash(contents);
    if (current !== file.beforeSha256 && current !== file.sha256) fail("MAIL_CONTACT_SOURCE_CHANGED");
    if (current !== file.sha256) alreadyAdapted = false;
    before.set(file.path, contents);
  }
  if (alreadyAdapted && (await probeContact(e, options.contactFetch)).supportContactReady) return { existing: true, buildPerformed: false };
  const parent = path.dirname(e.app), id = e.c.operationId;
  const stage = path.join(parent, `.contact-stage-${id}`), backup = path.join(parent, `.contact-backup-${id}`);
  const result = { stage, backup, before, patch, parent, activated: false, stopped: false, buildPerformed: true, movedBuild: false, installedBuild: false, touched: [] };
  try {
    const oldBuild = await fs.lstat(path.join(e.app, ".next"));
    if (!oldBuild.isDirectory() || oldBuild.isSymbolicLink()) fail("MAIL_CONTACT_BUILD_UNSAFE");
    result.previousBuildId = await e.regular(path.join(e.app, ".next/BUILD_ID"), true);
    if (!options.fixture) {
      const disk = await fs.statfs(parent); if (Number(disk.bavail) * Number(disk.bsize) < 2 * 1024 ** 3) fail("MAIL_CONTACT_DISK_LOW");
      const memory = await fs.readFile("/proc/meminfo", "utf8"), kib = name => Number(memory.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] || 0);
      if (kib("MemTotal") + kib("SwapTotal") < 3 * 1024 ** 2) fail("MAIL_CONTACT_MEMORY_LOW");
    }
    await fs.mkdir(stage, { mode: 0o750 }); await fs.mkdir(backup, { mode: 0o700 });
    const permitted = new Set(["app", "public", "next.config.ts", "proxy.ts", "tsconfig.json", "package.json", "package-lock.json", "next-env.d.ts", "core-client-design.json", "core-client-design-contract.cjs", "point-design-contract.cjs"]);
    for (const name of await fs.readdir(e.app)) if (permitted.has(name)) {
      await fs.cp(path.join(e.app, name), path.join(stage, name), { recursive: true, filter: file => !path.relative(e.app, file).split(path.sep).some(part => part === "uploads" || part.startsWith(".env")) });
    }
    for (const file of patch.files) { const target = path.join(stage, file.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.contents); }
    const modules = path.join(e.app, "node_modules"), stat = await fs.lstat(modules);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("MAIL_CONTACT_DEPENDENCIES_INVALID");
    await fs.symlink(modules, path.join(stage, "node_modules"), "junction");
    if (!options.fixture) await e.run("chown", ["-hR", `${e.user}:${e.user}`, stage]);
    if (options.build) await options.build(stage);
    else await buildContact(e, stage);
    const build = await fs.lstat(path.join(stage, ".next/BUILD_ID")); if (!build.isFile() || build.size < 1) fail("MAIL_CONTACT_BUILD_MISSING");
    result.nextBuildId = await fs.readFile(path.join(stage, ".next/BUILD_ID"), "utf8");
    return result;
  } catch (error) { await cleanupContact(e, result, false); if (error.code?.startsWith("MAIL_")) throw error; fail("MAIL_CONTACT_BUILD_FAILED"); }
}

async function buildContact(e, stage) {
  const log = await fs.open(path.join(e.shared, "contact-build.private.log"), "w", 0o600);
  try {
    await log.chmod(0o600);
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/sbin/runuser", ["-u", e.user, "--", process.execPath, path.join(stage, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd: stage, detached: true,
        env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: path.join(e.shared, "home"), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=1536", CORE_RUNTIME_CLIENT_ID: e.c.clientId }, stdio: ["ignore", log.fd, log.fd] });
      let timedOut = false, forceTimer;
      const stop = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch {} };
      const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); forceTimer = setTimeout(() => stop("SIGKILL"), 10000); }, 45 * 60 * 1000);
      child.once("error", () => { clearTimeout(timer); clearTimeout(forceTimer); stop("SIGKILL"); reject(Object.assign(Error("MAIL_CONTACT_BUILD_FAILED"), { code: "MAIL_CONTACT_BUILD_FAILED" })); });
      child.once("exit", code => {
        clearTimeout(timer); clearTimeout(forceTimer);
        if (timedOut) { stop("SIGKILL"); reject(Object.assign(Error("MAIL_CONTACT_BUILD_TIMEOUT"), { code: "MAIL_CONTACT_BUILD_TIMEOUT" })); }
        else code === 0 ? resolve() : reject(Object.assign(Error("MAIL_CONTACT_BUILD_FAILED"), { code: "MAIL_CONTACT_BUILD_FAILED" }));
      });
    });
  } finally { await log.close(); }
}

async function activateContact(e, prepared) {
  if (!prepared || prepared.existing) return;
  if (await e.regular(path.join(e.app, ".next/BUILD_ID"), true) !== prepared.previousBuildId) fail("MAIL_CONTACT_BUILD_CHANGED");
  for (const file of prepared.patch.files) {
    let current = null; try { current = await e.regular(path.join(e.app, file.path), true); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current !== prepared.before.get(file.path)) fail("MAIL_CONTACT_SOURCE_CHANGED");
  }
  await e.run("systemctl", ["stop", e.unit]); prepared.stopped = true;
  await fs.rename(path.join(e.app, ".next"), path.join(prepared.backup, ".next")); prepared.movedBuild = true;
  await fs.rename(path.join(prepared.stage, ".next"), path.join(e.app, ".next")); prepared.installedBuild = true;
  for (const file of prepared.patch.files) {
    const destination = path.join(e.app, file.path); await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.contents, { mode: 0o644 }); prepared.touched.push(file.path);
  }
  prepared.activated = true;
}
async function restoreContact(e, prepared) {
  if (!prepared || prepared.existing || !prepared.stopped) return;
  await e.run("systemctl", ["stop", e.unit]);
  for (const name of prepared.touched) {
    const file = path.join(e.app, name), original = prepared.before.get(name);
    if (await e.regular(file, true) !== prepared.patch.files.find(value => value.path === name).contents) fail("MAIL_CONTACT_SOURCE_CHANGED");
    if (original === null) await fs.unlink(file); else await fs.writeFile(file, original);
  }
  if (prepared.installedBuild) await fs.rename(path.join(e.app, ".next"), path.join(prepared.stage, ".next"));
  if (prepared.movedBuild) await fs.rename(path.join(prepared.backup, ".next"), path.join(e.app, ".next"));
  prepared.activated = false; prepared.stopped = false;
}
async function cleanupContact(e, prepared, committed) {
  if (!prepared || prepared.existing || prepared.stopped && !committed) return;
  for (const directory of [prepared.backup, ...(!committed ? [prepared.stage] : [])]) {
    if (path.dirname(path.resolve(directory)) !== path.dirname(e.app) || !/^\.contact-(?:stage|backup)-[a-f0-9-]{36}$/.test(path.basename(directory))) fail("MAIL_CONTACT_CLEANUP_UNSAFE");
    await fs.rm(directory, { recursive: true, force: true });
  }
  // Keep the successful source staging tree: Next's trace manifest may refer to its build-time path.
}
module.exports = { validatePatch, probeContact, prepareContact, activateContact, restoreContact, cleanupContact };
