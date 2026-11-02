"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), { execFile } = require("node:child_process"), { promisify } = require("node:util");
const root = path.resolve(__dirname, "../.."), run = promisify(execFile), UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const phases = { contracts: "Проверяю совместимость выбранного Git-кода...", dependencies: "Устанавливаю библиотеки выбранной LMS...", build: "Собираю выбранную LMS и проверяю TypeScript...", runtime: "Автоматически проверяю вход, сессии и PostgreSQL в отдельной тестовой базе...", ready: "Выбранная Git-версия подготовлена. Собираю установочный пакет..." };
function preparationEnvironments(input) {
  const build = Object.fromEntries(Object.entries(input).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA)$/i.test(key)));
  if (input.CORE_DESKTOP_MODE === "1") for (const key of ["CORE_DESKTOP_MODE", "CORE_TEST_BROWSER"]) if (input[key]) build[key] = input[key];
  // Only our trusted acceptance runner receives the local maintenance connection.
  // Downloaded npm/Next code must never receive the Core administrator database secret.
  const runtime = { ...build };
  if (input.CORE_DESKTOP_MODE === "1" && input.DATABASE_URL) runtime.DATABASE_URL = input.DATABASE_URL;
  return { build, runtime };
}
async function prepare(snapshotId) {
  if (!UUID.test(snapshotId)) throw Error("SOURCE_ID_INVALID");
  const output = path.join(root, "infra/runtime/source-preparation", snapshotId); await fs.mkdir(output, { recursive: true });
  const status = async step => { const file = path.join(output, "progress.json"), temp = file + "." + crypto.randomUUID() + ".tmp"; await fs.writeFile(temp, JSON.stringify({ snapshotId, step, message: phases[step], at: new Date().toISOString() }), { flag: "wx" }); await fs.rename(temp, file); };
  const base = path.join(root, "apps/control-center/dist"), tar = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "tar";
  const { SourceSnapshotService } = require(path.join(base, "source-snapshots.js")), { DeploymentPackageService } = require(path.join(base, "deployment-package.js")), { RuntimeSourceAdapterService } = require(path.join(base, "runtime-source-adapter.js"));
  const sources = new SourceSnapshotService(root, {}, tar), packages = new DeploymentPackageService(root, sources, process.env.CORE_GIT_PATH || (process.platform === "win32" ? "C:/Program Files/Git/cmd/git.exe" : "git"), tar);
  let step = "contracts";
  const environments = preparationEnvironments(process.env), environment = environments.build;
  const execute = async (file, args, settings, name) => {
    try { const result = await run(file, args, { cwd: root, windowsHide: true, timeout: 600000, maxBuffer: 4 * 1024 * 1024, env: environment, ...settings }); await fs.writeFile(path.join(output, name + ".log"), result.stdout + result.stderr); }
    catch (e) { await fs.writeFile(path.join(output, name + ".log"), String(e.stdout || "") + String(e.stderr || "")); throw Error("SOURCE_" + name.toUpperCase() + "_FAILED"); }
  };
  try {
    await status(step);
    const source = await new RuntimeSourceAdapterService(root, packages, tar).prepare(snapshotId);
    step = "dependencies"; await status(step);
    const npm = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    try { await fs.stat(npm); await execute(process.execPath, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source.sourcePath }, "dependencies"); }
    catch (e) { if (e.code !== "ENOENT") throw e; await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source.sourcePath, shell: process.platform === "win32" }, "dependencies"); }
    step = "build"; await status(step);
    const env = { ...environment, NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=3072", CORE_RUNTIME_CLIENT_ID: crypto.randomUUID(), AUTH_SECRET: crypto.randomBytes(48).toString("base64url") };
    await execute(process.execPath, [path.join(source.sourcePath, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd: source.sourcePath, env }, "build");
    step = "runtime"; await status(step);
    const auth = await fs.readFile(path.join(source.sourcePath, "app/api/auth/login/route.ts"), "utf8");
    const employeeFlow = auth.includes("requiresRegistration") ? "activation" : "direct";
    // This test creates marker-owned disposable SQL objects, never a client in the working Core DB.
    await execute(process.execPath, ["--test", path.join(root, "apps/control-center/tests/lms-runtime-e2e.cjs")], { env: { ...environments.runtime, CORE_TEST_LMS_SOURCE_ID: source.id, CORE_TEST_LMS_EMPLOYEE_FLOW: employeeFlow } }, "runtime");
    const receipt = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/local-acceptance", source.id, "acceptance.json"), "utf8"));
    if (receipt.sourceId !== source.id || receipt.revision !== source.revision || receipt.localEndToEnd !== true || receipt.productionBuild !== true || receipt.restrictedDatabaseRole !== true) throw Error("SOURCE_ACCEPTANCE_UNCONFIRMED");
    await status("ready"); return { sourceId: source.id, snapshotId, revision: source.revision, accepted: true };
  } catch (error) {
    const code = /^SOURCE_[A-Z_]{1,80}$/.test(error.message) ? error.message : step === "contracts" ? "SOURCE_CONTRACT_UNSUPPORTED" : "SOURCE_PREPARATION_FAILED";
    process.stderr.write(JSON.stringify({ errorCode: code, step, logDirectory: output })); throw Error(code);
  }
}
module.exports = { prepare, preparationEnvironments };
if (require.main === module) void prepare(process.argv[2]).then(value => process.stdout.write(JSON.stringify(value))).catch(() => { process.exitCode = 1; });
