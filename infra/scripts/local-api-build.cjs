"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const projects = ["packages/shared", "packages/db", "apps/api"];

function files(directory, extensions) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((item) => {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw Error("LOCAL_BUILD_SYMLINK_REFUSED");
    return item.isDirectory() ? files(file, extensions) : extensions.some((suffix) => file.endsWith(suffix)) ? [file] : [];
  });
}
function digest(root, inputs) {
  const hash = crypto.createHash("sha256");
  for (const file of [...new Set(inputs)].sort()) {
    hash.update(path.relative(root, file).replaceAll(path.sep, "/") + "\0");
    hash.update(fs.readFileSync(file)); hash.update("\0");
  }
  return hash.digest("hex");
}
function fingerprint(root) {
  const inputs = ["tsconfig.base.json", "pnpm-lock.yaml"].map((name) => path.join(root, name));
  const outputs = [];
  for (const project of projects) {
    const directory = path.join(root, project);
    for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json", "nest-cli.json"]) {
      const file = path.join(directory, name); if (fs.existsSync(file)) inputs.push(file);
    }
    inputs.push(...files(path.join(directory, "src"), [".ts", ".json"]));
    inputs.push(...fs.readdirSync(directory, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith(".ts")).map((item) => path.join(directory, item.name)));
    outputs.push(...files(path.join(directory, "dist"), [".js", ".cjs", ".json"]));
  }
  const required = ["packages/shared/dist/index.js", "packages/db/dist/src/index.js", "apps/api/dist/main.js"];
  return { inputHash: digest(root, inputs), outputHash: digest(root, outputs), complete: required.every((file) => fs.existsSync(path.join(root, file))) };
}
function compileProject(root, project, timeout) {
  const directory = path.join(root, project);
  const tsc = require.resolve("typescript/bin/tsc", { paths: [directory] });
  const result = spawnSync(process.execPath, [tsc, "--project", path.join(directory, "tsconfig.json")], { cwd: directory, windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: "utf8" });
  if (result.error || result.status !== 0) throw Error("LOCAL_API_BUILD_FAILED:" + project);
}
function ensureLocalApiBuild(root, compile = compileProject) {
  const before = fingerprint(root);
  const file = path.join(root, "infra/runtime/local-builds/api.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (before.complete && saved.version === 1 && saved.inputHash === before.inputHash && saved.outputHash === before.outputHash) return { rebuilt: false };
  } catch { /* Missing or damaged receipts require a real compiler pass, never stale execution. */ }
  const deadline = performance.now() + 70000;
  for (const project of projects) {
    const remaining = Math.floor(deadline - performance.now()); if (remaining <= 0) throw Error("LOCAL_API_BUILD_TIMEOUT");
    compile(root, project, remaining);
  }
  const after = fingerprint(root);
  if (!after.complete || before.inputHash !== after.inputHash) throw Error("LOCAL_API_BUILD_INPUT_CHANGED");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, inputHash: after.inputHash, outputHash: after.outputHash, builtAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
  return { rebuilt: true };
}
module.exports = { ensureLocalApiBuild, fingerprint };
