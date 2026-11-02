"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const exec = require("node:util").promisify(require("node:child_process").execFile);

(async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const base = "/opt/lms-core-https-fixtures"; await fs.mkdir(base, { recursive: true, mode: 0o755 });
  const directory = await fs.mkdtemp(path.join(base, "cli-"));
  try {
    await exec("python3", ["-m", "venv", directory], { timeout: 120000 });
    await exec(path.join(directory, "bin/python"), ["-m", "pip", "install", "--disable-pip-version-check", "certbot==5.9.0"], { timeout: 300000, maxBuffer: 1024 * 1024 });
    const executable = path.join(directory, "bin/certbot");
    const version = (await exec(executable, ["--version"])).stdout.trim(); assert.match(version, /^certbot 5\.9\.0\b/);
    const help = (await exec(executable, ["--help", "all"], { maxBuffer: 1024 * 1024 })).stdout;
    for (const flag of ["--required-profile", "--ip-address", "--webroot-path", "--keep-until-expiring", "--deploy-hook", "--cert-name"]) assert.ok(help.includes(flag), flag);
    // The real parser validates our command contract. Help exits before ACME/account/network actions.
    await exec(executable, ["certonly", "--non-interactive", "--agree-tos", "--register-unsafely-without-email", "--required-profile", "shortlived", "--webroot", "--webroot-path", directory,
      "--ip-address", "192.0.2.70", "--cert-name", "core-local-cli", "--keep-until-expiring", "--dry-run", "--server", "https://acme-staging-v02.api.letsencrypt.org/directory", "--help"], { maxBuffer: 1024 * 1024 });
    const receipt = { checkedAt: new Date().toISOString(), realCertbotVersion: version, realCliFlagsAndParser: true, acmeRequests: 0, accountRegistration: false, localPackageDownloadOnly: true };
    await fs.writeFile(path.join(process.argv[2], "certbot-cli-receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
  } finally {
    assert.equal(path.dirname(await fs.realpath(directory)), base); assert.ok(path.basename(directory).startsWith("cli-")); await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stderr || error.stack || error.message); process.exitCode = 1; });
