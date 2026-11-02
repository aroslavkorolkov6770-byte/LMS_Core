const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const tests = [
  "client-choice",
  "client-links",
  "client-search",
  "panel-selection",
  "unload-confirmation",
  "core-editor-state",
  "client-design",
  "branding-assets",
  "local-git-preview",
  "point-design", "point-browser", "point-sql", "point-inspector",
  "api-client-card", "client-site-view", "database-provision-scram", "database-provision", "deployment-package", "deployment-worker", "execution-policy", "fresh-install", "health-and-logs", "interface-preferences", "launcher-performance", "lms-viewer", "local-api-build", "local-preview-config", "log-tail", "new-deployment", "new-install-preflight", "new-install-worker", "new-installation", "page-readiness-cache", "panel-request", "postgres-preview", "preview-backend", "preview-controls", "preview-draft", "preview-request", "refresh-queue", "remote-deployment", "remote-target", "repository", "runtime-backend-package", "runtime-contract", "runtime-postgres", "runtime-source-adapter", "server-preparation", "source-snapshots", "update-preflight"
].map((name) => `${name}.test.cjs`);

async function run(args, logFile) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; if (process.env.CORE_TEST_VERBOSE === "1") process.stdout.write(chunk); });
    child.once("error", reject);
    child.once("exit", async (code) => {
      try { await fs.writeFile(logFile, output); } catch (error) { reject(error); return; }
      if (code !== 0) { reject(new Error(`Local verification failed (${code}); see ${path.basename(logFile)}`)); return; }
      resolve({ durationMs: Date.now() - started, output });
    });
  });
}

(async () => {
  if (!/^[a-f0-9-]{36}$/i.test(process.env.CORE_TEST_LMS_SOURCE_ID || "")) throw new Error("Set CORE_TEST_LMS_SOURCE_ID to an existing accepted local runtime source. The real runtime E2E must not be silently skipped.");
  if (!process.env.CORE_TEST_DESIGN_PACKAGES) throw new Error("Set CORE_TEST_DESIGN_PACKAGES to a completed two-client design-package receipt; personalization E2E must not be silently skipped.");
  const designReceipt = JSON.parse(await fs.readFile(process.env.CORE_TEST_DESIGN_PACKAGES, "utf8"));
  if (designReceipt.sourceId !== process.env.CORE_TEST_LMS_SOURCE_ID || designReceipt.packages?.length !== 2 || designReceipt.externalActions !== false) throw new Error("Invalid local design-package receipt.");
  const directory = path.join(root, "apps/control-center/tests");
  const discovered = (await fs.readdir(directory)).filter((name) => name.endsWith(".test.cjs")).sort();
  if (JSON.stringify(discovered) !== JSON.stringify([...tests].sort())) throw new Error("Local test manifest changed; review the new/missing tests before running this accepted suite.");
  const output = path.join(root, "infra/runtime/local-acceptance/regression-20261029", randomUUID());
  await fs.mkdir(output, { recursive: true });
  const tsc = createRequire(path.join(root, "apps/control-center/package.json")).resolve("typescript/bin/tsc");
  const checks = {};
  for (const project of ["control-center", "api", "lms-web", "deploy-panel"]) {
    console.log(`Checking TypeScript: ${project}`);
    const result = await run([tsc, "--project", `apps/${project}/tsconfig.json`, ...(["control-center", "api"].includes(project) ? [] : ["--noEmit"])], path.join(output, `typescript-${project}.log`));
    checks[project] = { passed: true, durationMs: result.durationMs };
  }
  console.log("Running accepted local code/runtime suite (full output is kept in tests.tap)...");
  const result = await run(["--test", "--test-concurrency=1", "--test-reporter=tap", ...tests.map((name) => `apps/control-center/tests/${name}`), "apps/control-center/tests/lms-runtime-e2e.cjs", "apps/control-center/tests/design-runtime-e2e.cjs", "apps/control-center/tests/local-git-preview-e2e.cjs", "apps/control-center/tests/source-preview-e2e.cjs", "apps/control-center/tests/point-runtime-e2e.cjs"], path.join(output, "tests.tap"));
  const counts = {};
  for (const name of ["tests", "pass", "fail", "skipped", "cancelled"]) {
    const match = result.output.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
    if (!match) throw new Error("Incomplete TAP summary");
    counts[name] = Number(match[1]);
  }
  if (counts.fail || counts.skipped || counts.cancelled || counts.pass !== counts.tests) throw new Error("Local verification contains a failure, skip, or incomplete result");
  console.log("Checking renderer interactions...");
  const renderer = await run(["apps/control-center/tests/renderer-smoke.cjs"], path.join(output, "renderer-smoke.log"));
  process.env.CORE_TEST_STORAGE_FAULT = "1";
  let storageFault;
  try { storageFault = await run(["apps/control-center/tests/renderer-smoke.cjs"], path.join(output, "renderer-storage-fault.log")); }
  finally { delete process.env.CORE_TEST_STORAGE_FAULT; }
  process.env.CORE_TEST_FRAME_LIFECYCLE = "1";
  let frameLifecycle;
  try { frameLifecycle = await run(["apps/control-center/tests/renderer-smoke.cjs"], path.join(output, "renderer-frame-lifecycle.log")); }
  finally { delete process.env.CORE_TEST_FRAME_LIFECYCLE; }
  process.env.CORE_TEST_DRAFT_NAVIGATION = "1";
  let draftNavigation;
  try { draftNavigation = await run(["apps/control-center/tests/renderer-smoke.cjs"], path.join(output, "renderer-draft-navigation.log")); }
  finally { delete process.env.CORE_TEST_DRAFT_NAVIGATION; }
  const receipt = { checkedAt: new Date().toISOString(), sourceId: process.env.CORE_TEST_LMS_SOURCE_ID, typeChecks: checks, counts, suiteDurationMs: result.durationMs, rendererSmoke: { passed: true, durationMs: renderer.durationMs }, rendererStorageFault: { passed: true, durationMs: storageFault.durationMs }, externalSshOrDeploymentRun: false };
  receipt.designPackages = designReceipt.packages.map(({ clientId, artifact }) => ({ clientId, packageId: artifact.id, designSha256: artifact.design.sha256 }));
  receipt.rendererFrameLifecycle = { passed: true, durationMs: frameLifecycle.durationMs };
  receipt.rendererDraftNavigation = { passed: true, durationMs: draftNavigation.durationMs };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, output }));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
