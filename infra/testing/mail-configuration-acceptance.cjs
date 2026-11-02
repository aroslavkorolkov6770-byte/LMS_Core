"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const toLinux = file => "/mnt/" + file[0].toLowerCase() + file.slice(2).replaceAll("\\", "/");
async function run(file, args, output, name, env = {}, input, exactEnv = false) {
  const text = await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, windowsHide: true, env: exactEnv ? env : { ...process.env, CORE_TEST_MAIL: "0", ...env }, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let log = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += chunk; });
    child.once("error", reject);
    child.once("exit", code => { fs.writeFile(path.join(output, name + ".log"), log).then(() => code === 0 ? resolve(log) : reject(Error(`${name} failed; see ${output}`)), reject); });
    if (input) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  });
  return text;
}
async function nextEnvironment(output) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "core-mail-next-"));
  try {
    const next = require.resolve("next/package.json", { paths: [path.join(root, "apps/deploy-panel")] });
    const nextEnv = require.resolve("@next/env", { paths: [path.dirname(next)] });
    const mail = require("../scripts/configure-lms-mail.cjs"), ai = require("../scripts/configure-lms-ai.cjs");
    const passwords = ["fixture $cash# with spaces", "fixture 'apostrophe $cash\\n", 'fixture `backtick "double $cash'];
    for (let index = 0; index < passwords.length; index++) {
      const settings = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "465", SMTP_SECURE: "true", SMTP_USER: "sender@example.invalid", SMTP_PASS: passwords[index] };
      const contents = ai.upsertEnv("AI_API_KEY=unchanged-fixture-ai\n", settings, randomUUID(), Object.keys(settings), mail.encodeEnv);
      await fs.writeFile(path.join(directory, ".env.production.local"), contents);
      const environment = require("../scripts/runtime-process.cjs").roleEnvironment({ clientId: "fixture", releaseId: "fixture", apiPort: 4101, webPort: 3000 }, { authSecret: "fixture", serviceToken: "fixture" }, "web");
      const script = `require(${JSON.stringify(nextEnv)}).loadEnvConfig(${JSON.stringify(directory)},false,{info(){},error(){}},true);if(process.env.SMTP_PASS!==${JSON.stringify(passwords[index])}||process.env.AI_API_KEY!=='unchanged-fixture-ai')process.exit(1);console.log('Next SMTP literal password and unchanged AI accepted; no secrets returned');`;
      await run(process.execPath, ["-"], output, "next-env-" + index, environment, script, true);
    }
    return passwords.length;
  } finally { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("core-mail-next-")); await fs.rm(directory, { recursive: true, force: true }); }
}

(async () => {
  const output = path.join(root, "infra/runtime/local-acceptance/mail-configuration-20261030", randomUUID());
  await fs.mkdir(output, { recursive: true }); console.log("Mail acceptance: " + output);
  await run(process.execPath, ["apps/control-center/node_modules/typescript/bin/tsc", "--project", "apps/control-center/tsconfig.json"], output, "typescript");
  const tap = await run("wsl.exe", ["-d", "LMS-Core-Clean-Test", "-u", "root", "--", "node", "--test", "--test-reporter=tap", toLinux(path.join(root, "apps/control-center/tests/mail-configuration.test.cjs"))], output, "mail-tests");
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map(key => [key, Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1])]));
  assert.ok(counts.tests && counts.tests === counts.pass && !counts.fail && !counts.skipped && !counts.cancelled);
  const nextPasswordCases = await nextEnvironment(output); console.log("Mail input/worker/service and Next env accepted");
  await run("wsl.exe", ["-d", "LMS-Core-Clean-Test", "-u", "root", "--", "node", toLinux(path.join(root, "infra/testing/mail-linux-acceptance.cjs"))], output, "linux-smtp");
  console.log("Local Linux TLS/STARTTLS delivery accepted");
  await run(process.execPath, ["apps/control-center/tests/renderer-smoke.cjs"], output, "renderer-mail", { CORE_TEST_OUTPUT: output, CORE_TEST_MAIL: "1", CORE_TEST_AI: "0", CORE_TEST_PERFORMANCE: "0", CORE_TEST_DEPLOYMENT: "0", CORE_TEST_VISUAL: "0", CORE_TEST_SOURCE_LIBRARY: "0", CORE_TEST_STORAGE_FAULT: "0", CORE_TEST_FRAME_LIFECYCLE: "0", CORE_TEST_DRAFT_NAVIGATION: "0" });
  console.log("Full previous regression, including AI and performance");
  const previousLog = await run(process.execPath, ["infra/testing/performance-acceptance.cjs"], output, "previous-regression");
  const previousLine = previousLog.trim().split(/\r?\n/).findLast(line => line.startsWith('{"checkedAt"')); assert.ok(previousLine);
  const previous = JSON.parse(previousLine);
  const receipt = { checkedAt: new Date().toISOString(), counts, nextPasswordCases, realLocalLinuxSmtp: true, mailRenderer: true, previous,
    totalPassingTests: counts.pass + previous.totalPassingTests, rendererModes: previous.rendererModes + 1, externalSshEmailProviderRequests: false, output };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
