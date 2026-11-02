"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { bundleDependencies } = require("./dependency-bundle.cjs");
const root = path.resolve(__dirname, "../.."), run = promisify(execFile);
const projects = ["packages/shared", "packages/db", "apps/api", "apps/control-center", "apps/deploy-panel"];
const forbidden = /^(?:\.env(?:\..*)?|launcher-(?:config|secrets).*\.json|\.git|\.next|node_modules|runtime|local-postgres|private-storage|data)$/i;
function copyProjectFile(project, relative) {
  const parts = relative.split(path.sep);
  return !(project === "apps/control-center" && parts[0] === "config") && parts[0] !== "tests" && !parts.some(part => forbidden.test(part) || part === ".next-desktop") && !relative.endsWith(".tsbuildinfo");
}
async function copy(source, target, filter = () => true) { await fs.cp(source, target, { recursive: true, dereference: true, filter }); }
async function build() {
  if (process.platform !== "win32" || process.arch !== "x64") throw Error("DESKTOP_WINDOWS_X64_REQUIRED");
  const id = crypto.randomUUID(), staging = path.join(root, "infra/runtime/desktop-builds", id), workspace = path.join(staging, "workspace"), tools = path.join(staging, "tools"), shell = path.join(staging, "app");
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(shell);
  for (const project of projects) {
    const source = path.join(root, project), target = path.join(workspace, project);
    await copy(source, target, file => copyProjectFile(project, path.relative(source, file)));
  }
  for (const name of ["package.json", "pnpm-lock.yaml", "tsconfig.base.json"]) await copy(path.join(root, name), path.join(workspace, name));
  for (const directory of ["scripts", "lms-adapter"]) await copy(path.join(root, "infra", directory), path.join(workspace, "infra", directory));
  for (const name of ["lms-runtime-e2e.cjs", "fresh-install-test-helper.cjs", "database-provision-test-helper.cjs", "runtime-test-helper.cjs"]) await copy(path.join(root, "apps/control-center/tests", name), path.join(workspace, "apps/control-center/tests", name));
  await copy(path.join(root, "apps/deploy-panel/.next-desktop"), path.join(workspace, "apps/deploy-panel/.next-desktop"), file => !path.relative(path.join(root, "apps/deploy-panel/.next-desktop"), file).split(path.sep).includes("cache"));
  const dependencies = await bundleDependencies(root, workspace, projects);
  for (const name of ["apps/api/dist/modules/tests/tests.module.js", "apps/api/dist/modules/database/database.module.js", "apps/control-center/dist/main.js", "packages/db/src/seed/roles.ts", "apps/deploy-panel/.next-desktop/BUILD_ID"]) await fs.access(path.join(workspace, name));
  await fs.writeFile(path.join(workspace, "desktop-bundle.json"), JSON.stringify({ format: "lms-core-desktop-v1", id, version: "0.1.1", createdAt: new Date().toISOString(), ...dependencies }));
  console.log("Locked packages copied:", dependencies.packages.length);
  const nodeRoot = path.dirname(process.execPath), gitRoot = path.join(process.env.ProgramFiles || "C:/Program Files", "Git"), pgRoot = path.join(process.env.ProgramFiles || "C:/Program Files", "PostgreSQL/18");
  for (const name of ["node.exe", "npm.cmd", "npm", "npx.cmd", "npx"]) await copy(path.join(nodeRoot, name), path.join(tools, "node", name));
  await copy(path.join(nodeRoot, "node_modules/npm"), path.join(tools, "node/node_modules/npm"));
  const licenseCache = path.join(root, "infra/runtime/packaging-tools", `node-LICENSE-${process.version}.txt`);
  let license;
  try { license = await fs.readFile(licenseCache, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error("NODE_LICENSE_REQUIRED"); license = await response.text();
  }
  if (!license.includes("Node.js is licensed")) throw Error("NODE_LICENSE_INVALID");
  await fs.writeFile(path.join(tools, "node/LICENSE"), license);
  for (const name of ["bin", "cmd", "etc", "mingw64", "usr", "LICENSE.txt"]) await copy(path.join(gitRoot, name), path.join(tools, "git", name), file => !path.relative(path.join(gitRoot, name), file).split(path.sep).some(part => ["doc", "man", "tmp"].includes(part)));
  for (const name of ["bin", "lib", "share", "server_license.txt", "commandlinetools_3rd_party_licenses.txt"]) await copy(path.join(pgRoot, name), path.join(tools, "postgres", name));
  for (const name of ["bootstrap.cjs", "dependency-bundle.cjs"]) await copy(path.join(__dirname, name), path.join(shell, name));
  await copy(path.join(root, "apps/control-center/renderer/assets/core-mark.ico"), path.join(shell, "core-mark.ico"));
  await fs.writeFile(path.join(shell, "package.json"), JSON.stringify({ name: "lms-core-desktop", productName: "LMS Core", version: "0.1.1", description: "LMS Core Control Center", author: "LMS Core", main: "bootstrap.cjs", private: true }));
  const config = { appId: "ru.lmscore.desktop", productName: "LMS Core", directories: { app: shell, output: path.join(root, "dist-installers") }, asar: true,
    electronVersion: require(path.join(root, "apps/control-center/node_modules/electron/package.json")).version,
    electronDist: path.join(root, "apps/control-center/node_modules/electron/dist"),
    files: ["package.json", "*.cjs", "core-mark.ico"], extraResources: [{ from: workspace, to: "workspace" }, { from: tools, to: "tools" }, ...["stop-desktop.cjs", "dependency-bundle.cjs"].map(name => ({ from: path.join(__dirname, name), to: name }))],
    npmRebuild: false, compression: "normal", artifactName: "LMS-Core-Setup-${version}-${arch}.${ext}",
    win: { target: [{ target: "nsis", arch: ["x64"] }], icon: path.join(shell, "core-mark.ico"), signAndEditExecutable: true },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: "LMS Core", deleteAppDataOnUninstall: false, runAfterFinish: false, useZip: true, differentialPackage: false, installerLanguages: ["ru_RU", "en_US"], include: path.join(__dirname, "installer.nsh") } };
  const configPath = path.join(staging, "builder.json"); await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(root, "infra/runtime/desktop-build-latest.json"), JSON.stringify({ id, staging, configPath, workspace, tools, shell, packageCount: dependencies.packages.length }));
  if (process.argv.includes("--stage-only")) { console.log(JSON.stringify({ staging, configPath })); return; }
  const builder = path.join(root, "infra/runtime/packaging-tools/node_modules/electron-builder/cli.js");
  const result = await run(process.execPath, [builder, "--config", configPath, "--win", "--x64"], { cwd: root, windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || "1" } });
  process.stdout.write(result.stdout + result.stderr);
}
module.exports = { build, forbidden, copyProjectFile };
if (require.main === module) void build().catch(error => { console.error(error.message); if (error.stdout) console.error(error.stdout); if (error.stderr) console.error(error.stderr); process.exitCode = 1; });
