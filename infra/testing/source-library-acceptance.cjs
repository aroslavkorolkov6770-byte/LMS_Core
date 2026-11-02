const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
async function run(args, output, name, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...environment }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { text += chunk; });
    child.once("error", reject);
    child.once("exit", async (code) => {
      try { await fs.writeFile(path.join(output, name + ".log"), text); if (code !== 0) throw Error(`${name} failed; see ${output}`); resolve(text); } catch (error) { reject(error); }
    });
  });
}
(async () => {
  const output = path.join(root, "infra/runtime/local-acceptance/source-library-20261029", randomUUID());
  await fs.mkdir(output, { recursive: true });
  console.log("TypeScript: Control Center");
  await run(["apps/control-center/node_modules/typescript/bin/tsc", "--project", "apps/control-center/tsconfig.json"], output, "typescript");
  const suites = ["source-library", "repository", "interface-preferences", "deployment-workflow"];
  const tap = await run(["--test", "--test-reporter=tap", ...suites.map((name) => `apps/control-center/tests/${name}.test.cjs`)], output, "tests");
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map((key) => [key, Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1])]));
  if (counts.tests !== counts.pass || counts.fail || counts.skipped || counts.cancelled || !counts.tests) throw Error("Incomplete source library test acceptance.");
  for (const mode of ["sources", "normal", "storage", "frame", "draft", "visual", "deployment"]) {
    console.log("Renderer: " + mode);
    await run(["apps/control-center/tests/renderer-smoke.cjs"], output, "renderer-" + mode, {
      CORE_TEST_OUTPUT: output, CORE_TEST_AI: "0", CORE_TEST_MAIL: "0", CORE_TEST_PERFORMANCE: "0", CORE_TEST_DEPLOYMENT: mode === "deployment" ? "1" : "0", CORE_TEST_VISUAL: mode === "visual" ? "1" : "0", CORE_TEST_SOURCE_LIBRARY: mode === "sources" ? "1" : "0", CORE_TEST_STORAGE_FAULT: mode === "storage" ? "1" : "0",
      CORE_TEST_FRAME_LIFECYCLE: mode === "frame" ? "1" : "0", CORE_TEST_DRAFT_NAVIGATION: mode === "draft" ? "1" : "0"
    });
  }
  const ico = await fs.readFile(path.join(root, "apps/control-center/renderer/assets/core-mark.ico"));
  if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 7) throw Error("Icon frames are incomplete.");
  const receipt = { checkedAt: new Date().toISOString(), counts, rendererModes: 7, iconFrames: 7, typeCheck: true, externalGitSshDeploymentRun: false, output };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
