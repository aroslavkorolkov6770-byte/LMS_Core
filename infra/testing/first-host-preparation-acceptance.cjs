const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../..");

async function run(file, args, output, name, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: { ...process.env, ...extra }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let result = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { result += chunk; });
    child.once("error", reject);
    child.once("exit", async (code) => {
      try {
        await fs.writeFile(path.join(output, name + ".log"), result);
        if (code !== 0) throw Error(`${name} failed (${code}); inspect its local log.`);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

(async () => {
  const output = path.join(root, "infra/runtime/local-acceptance/first-host-preparation-20261029", randomUUID());
  await fs.mkdir(output, { recursive: true });
  const tsc = createRequire(path.join(root, "apps/control-center/package.json")).resolve("typescript/bin/tsc");
  for (const app of ["control-center", "api", "lms-web", "deploy-panel"]) {
    console.log(`TypeScript: ${app}`);
    await run(process.execPath, [tsc, "--project", `apps/${app}/tsconfig.json`, ...(app === "control-center" ? [] : ["--noEmit"])], output, "typescript-" + app);
  }
  const suites = ["server-preparation", "new-installation", "new-install-preflight", "new-install-worker", "execution-policy", "remote-target", "new-deployment", "fresh-install", "ip-publication", "ip-publication-worker"];
  console.log("Checking local preparation, resource, SSH and installation guards...");
  const tap = await run(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", ...suites.map((name) => `apps/control-center/tests/${name}.test.cjs`)], output, "tests");
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map((key) => [key, Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1])]));
  if (!Object.values(counts).every(Number.isInteger) || counts.tests !== counts.pass || counts.fail || counts.skipped || counts.cancelled) throw Error("Incomplete preparation test acceptance.");
  for (const mode of ["normal", "storage", "frame", "draft"]) {
    console.log(`Renderer: ${mode}`);
    await run(process.execPath, ["apps/control-center/tests/renderer-smoke.cjs"], output, "renderer-" + mode, {
      CORE_TEST_STORAGE_FAULT: mode === "storage" ? "1" : "0", CORE_TEST_FRAME_LIFECYCLE: mode === "frame" ? "1" : "0", CORE_TEST_DRAFT_NAVIGATION: mode === "draft" ? "1" : "0"
    });
  }
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "/bin/sh";
  for (const name of ["prepare-clean-server.sh", "prepare-build-memory.sh"]) await run(shell, ["-n", "infra/scripts/" + name], output, "syntax-" + name);
  const receipt = { checkedAt: new Date().toISOString(), counts, typeChecks: 4, rendererModes: 4, shellSyntax: true, shellSwapFixture: "allocation/activation/POSIX metadata and flock mocked; not real kernel swap acceptance", externalSshOrDeploymentRun: false };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, output }));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
