"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const toLinux = file => "/mnt/" + file[0].toLowerCase() + file.slice(2).replaceAll("\\", "/");
function counts(tap) {
  const result = Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map(key => [key, Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1])]));
  assert.ok(result.tests && result.tests === result.pass && !result.fail && !result.skipped && !result.cancelled); return result;
}
(async () => {
  const output = path.join(root, "infra/runtime/local-acceptance/ip-https-20261030", randomUUID());
  await fs.mkdir(output, { recursive: true }); console.log("HTTPS acceptance: " + output);
  async function run(file, args, name, env = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd: root, windowsHide: true, env: { ...process.env, CORE_TEST_HTTPS: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let log = ""; for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { log += data; });
      child.once("error", reject); child.once("exit", code => { fs.writeFile(path.join(output, name + ".log"), log).then(() => code === 0 ? resolve(log) : reject(Error(name + " failed: " + log.slice(-3000))), reject); });
    });
  }
  await run(process.execPath, ["apps/control-center/node_modules/typescript/bin/tsc", "--project", "apps/control-center/tsconfig.json"], "typescript");
  const local = counts(await run(process.execPath, ["--test", "--test-reporter=tap", "apps/control-center/tests/ip-publication.test.cjs", "apps/control-center/tests/ip-publication-worker.test.cjs", "apps/control-center/tests/support-contact.test.cjs"], "publication-and-contact"));
  const tls = counts(await run("wsl.exe", ["-d", "LMS-Core-Clean-Test", "-u", "root", "--", "node", "--test", "--test-reporter=tap", toLinux(path.join(root, "apps/control-center/tests/ip-https-worker.test.cjs"))], "https-worker"));
  console.log("HTTPS service/worker and HTTP/contact regression accepted");
  for (const [file, name] of [["infra/testing/linux/ip-https-acceptance.cjs", "linux-tls"], ["infra/testing/linux/certbot-cli-acceptance.cjs", "certbot-cli"]]) {
    await run("wsl.exe", ["-d", "LMS-Core-Clean-Test", "-u", "root", "--", ...(name === "linux-tls" ? ["unshare", "--net", "--"] : []), "node", toLinux(path.join(root, file)), toLinux(output), ...(name === "linux-tls" ? ["--isolated-network"] : [])], name);
    console.log(name + " accepted");
  }
  await run(process.execPath, ["apps/control-center/tests/renderer-smoke.cjs"], "renderer-https", { CORE_TEST_OUTPUT: output, CORE_TEST_HTTPS: "1", CORE_TEST_MAIL: "0", CORE_TEST_AI: "0", CORE_TEST_PERFORMANCE: "0", CORE_TEST_DEPLOYMENT: "0", CORE_TEST_VISUAL: "0", CORE_TEST_SOURCE_LIBRARY: "0", CORE_TEST_STORAGE_FAULT: "0", CORE_TEST_FRAME_LIFECYCLE: "0", CORE_TEST_DRAFT_NAVIGATION: "0" });
  console.log("HTTPS renderer accepted; running all previous mail/AI/performance scenarios");
  const log = await run(process.execPath, ["infra/testing/mail-configuration-acceptance.cjs"], "previous-regression");
  const line = log.trim().split(/\r?\n/).findLast(value => value.startsWith('{"checkedAt"')); assert.ok(line);
  const previous = JSON.parse(line);
  const receipt = { checkedAt: new Date().toISOString(), targeted: local, tlsWorker: tls, previous, realLocalNginxTls: true, localRenewalService: true, realCertbotCli: true,
    totalUniquePassingTests: local.pass + tls.pass + previous.totalPassingTests, rendererModes: previous.rendererModes + 1, externalAcmeVpsSmtpRequests: false, output };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
