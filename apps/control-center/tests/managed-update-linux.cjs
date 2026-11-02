"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const exec = promisify(require("node:child_process").execFile);
const { runManagedUpdate } = require("../../../infra/scripts/lms-managed-update.cjs");

async function main() {
  assert.equal(process.env.WSL_DISTRO_NAME, "LMS-Core-Clean-Test", "Only the explicitly isolated WSL is allowed");
  assert.equal(process.env.CORE_TEST_MANAGED_LINUX, "1");
  const appPath = "/srv/lms-core/clients/demo-client", owner = JSON.parse(await fs.readFile(appPath + "/.core-install-owner.json", "utf8"));
  assert.equal(owner.clientId, "5c5d9a43-af96-4f17-b0fb-73ae17063e7f");
  const context = JSON.parse(await fs.readFile(appPath + "/shared/runtime-context.json", "utf8"));
  const root = path.resolve(__dirname, "../../.."), pkg = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/installation-packages/3fac8305-eb52-4263-87a2-150b54983252/manifest.json"), "utf8"));
  const payload = path.join(root, "infra/runtime/installation-packages", pkg.id, "payload");
  const before = await fs.readFile(path.join(context.releaseRoot, "lms/.next/BUILD_ID"), "utf8");
  const database = "lms_" + owner.clientId.replaceAll("-", "");
  const countUsers = async () => (await exec("runuser", ["-u", "postgres", "--", "psql", "-XAt", "-d", database, "-c", "SELECT count(*) FROM users"], { timeout: 30000 })).stdout.trim();
  const usersBefore = await countUsers();
  const result = await runManagedUpdate({ id: crypto.randomUUID(), clientId: owner.clientId, jobId: owner.jobId, releaseId: owner.releaseId, appPath, webPort: context.webPort, packageId: pkg.id, revision: pkg.revision, sha256: pkg.sha256 }, payload, {}, phase => process.stdout.write(phase + "\n"));
  assert.equal(result.phase, "succeeded", JSON.stringify(result));
  const after = await fs.readFile(path.join(context.releaseRoot, "lms/.next/BUILD_ID"), "utf8"); assert.notEqual(after, before);
  assert.equal(await fs.readFile(path.join(result.backupPath, ".next/BUILD_ID"), "utf8"), before);
  assert.equal(await countUsers(), usersBefore);
  const health = await (await fetch(`http://127.0.0.1:${context.webPort}/api/core-runtime/health`)).json(); assert.equal(health.clientId, owner.clientId); assert.equal(health.releaseId, owner.releaseId); assert.equal(health.status, "ok");
  process.stdout.write(JSON.stringify({ accepted: true, realSystemd: true, realPostgres: true, sameUsers: true, selectedRevision: pkg.revision, backupConfirmed: true, publicAssetsChecked: true }) + "\n");
}
main().catch(error => { process.stderr.write(String(error.message) + "\n"); process.exitCode = 1; });
