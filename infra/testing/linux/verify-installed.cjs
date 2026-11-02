"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
async function main() {
  if (process.platform !== "linux" || process.getuid() !== 0 || !/^[a-f0-9-]{36}$/.test(process.argv[2])) throw Error("INVALID_LOCAL_TEST_TARGET");
  const original = `/srv/lms-core/jobs/${process.argv[2]}`;
  const config = JSON.parse(await fs.readFile(path.join(original, "job.json"), "utf8"));
  const { createInstallDriver, executeNewInstall } = require(path.join(original, "lms-new-install-worker.cjs"));
  const marker = `/srv/lms-core/clients/${config.job.client.slug}/.core-install-owner.json`;
  const before = await fs.readFile(marker, "utf8");
  const secret = { databaseUrl: "postgresql://fixture@127.0.0.1/unused", clientAdminLogin: "fixture.admin", clientAdminName: "Fixture", clientAdminPassword: crypto.randomBytes(24).toString("base64url"), systemAdminLogin: "fixture.system", systemAdminPassword: crypto.randomBytes(24).toString("base64url") };
  const occupied = await executeNewInstall(createInstallDriver(config.job, secret, path.join(original, "payload")));
  if (occupied.phase !== "failed" || occupied.errorCode !== "INSTALL_PATH_OCCUPIED" || before !== await fs.readFile(marker, "utf8")) throw Error("OCCUPIED_INSTALLATION_CHANGED");
  for (const role of ["api", "web"]) await run("systemctl", ["is-active", "--quiet", `lms-${config.job.client.slug}-${role}.service`]);
  const id = crypto.randomUUID(), directory = `/srv/lms-core/jobs/${id}`;
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.copyFile(path.join(original, "code.tar"), path.join(directory, "code.tar"));
  const badJob = { ...config.job, id, client: { ...config.job.client, id: crypto.randomUUID(), slug: "hash-test-" + id.slice(0, 8) } };
  const { executeJob } = require(path.join(original, "lms-install-job.cjs"));
  const rejected = await executeJob(path.join(directory, "job.json"), { job: badJob, sha256: "0".repeat(64) }, {});
  if (rejected.phase !== "failed" || rejected.errorCode !== "ARCHIVE_HASH_MISMATCH") throw Error("CORRUPTED_ARCHIVE_NOT_REJECTED");
  try { await fs.stat(path.join(directory, "payload")); throw Error("ARCHIVE_EXTRACTED_BEFORE_HASH"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const response = await fetch(`http://127.0.0.1:${config.job.webPort}/api/core-runtime/health`);
  const health = await response.json();
  if (!response.ok || health.clientId !== config.job.client.id || health.releaseId !== config.job.releaseId) throw Error("INSTALLED_HEALTH_MISMATCH");
  const denied = await fetch(`http://127.0.0.1:${config.job.apiPort}/api/lms-runtime/v1/health`);
  if (denied.status !== 401) throw Error("PRIVATE_API_WITHOUT_TOKEN");
  process.stdout.write(JSON.stringify({ occupiedRefusedWithoutChange: true, corruptedArchiveRefusedBeforeExtraction: true, servicesRemainActive: true, privateApiRequiresToken: true, healthIdentityConfirmed: true, checkedAt: new Date().toISOString() }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
