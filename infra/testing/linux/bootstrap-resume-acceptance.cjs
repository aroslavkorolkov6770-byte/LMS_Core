"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), net = require("node:net"), assert = require("node:assert/strict");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const run = promisify(execFile), root = path.resolve(__dirname, "../../..");
const worker = require(path.join(root, "infra/scripts/lms-new-install-worker.cjs"));
const { resumeBootstrappedInstallation } = require(path.join(root, "infra/scripts/resume-lms-installation.cjs"));
const { openSecrets } = require(path.join(root, "infra/scripts/runtime-process.cjs"));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
let diagnosticStage = "start";
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
const sql = query => run("runuser", ["-u", "postgres", "--", "psql", "-XAtw", "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", query]);

async function scenario(packageId, oldPackageId, mode) {
  const id = crypto.randomUUID(), clientId = crypto.randomUUID(), slug = "resume-test-" + id.slice(0, 12), directory = `/srv/lms-core/jobs/${id}`;
  const appPath = `/srv/lms-core/clients/${slug}`, payload = path.join(directory, "payload");
  const job = { version: 1, id, releaseId: packageId, client: { id: clientId, name: "Local resume fixture", brandName: "Fixture", slug, domain: "fixture.invalid", tariff: "base", industryTemplate: "coffee_shop" }, contentMode: mode, apiPort: await freePort(), webPort: await freePort() };
  const user = "lms-" + digest(Buffer.from(clientId)).slice(0, 20), suffix = clientId.replaceAll("-", ""), database = "lms_" + suffix, role = "lms_role_" + suffix;
  const services = ["api", "web"].map(value => `lms-${slug}-${value}.service`);
  let createdApp = false, createdJob = false;
  try {
    await fs.mkdir("/srv/lms-core/jobs", { recursive: true }); await fs.mkdir(directory, { mode: 0o700 }); createdJob = true;
    await fs.cp(path.join(root, "infra/runtime/installation-packages", packageId, "payload"), payload, { recursive: true });
    const manifestFile = path.join(payload, "release-manifest.json"), manifest = JSON.parse(await fs.readFile(manifestFile));
    manifest.contentMode = mode;
    if (mode === "source") {
      const bundle = { version: 1, revision: manifest.revision, entries: [{ key: "core_lms_route_v1", data: [{ id: "fixture-topic", title: "Isolated topic" }] }, { key: "core_lms_tests_v1", data: [{ id: "fixture-test", title: "Isolated test", quiz: [{ q: "Fixture?", o: ["Yes", "No"], c: 0 }] }] }] };
      const bytes = Buffer.from(JSON.stringify(bundle)); await fs.writeFile(path.join(payload, "installer/source-curriculum.json"), bytes);
      manifest.files.push({ path: "installer/source-curriculum.json", sha256: digest(bytes) });
      manifest.curriculum = require(path.join(root, "infra/scripts/source-curriculum.cjs")).curriculumSummary(bundle);
    }
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    await run("tar", ["-cf", path.join(directory, "code.tar"), "-C", payload, "."]);
    await fs.writeFile(path.join(directory, "job.json"), JSON.stringify({ job, sha256: digest(await fs.readFile(path.join(directory, "code.tar"))) }), { mode: 0o600 });
    // Replay the real broken launcher boundary, not a mock API: lazy dependency is missing at bootstrap.
    await fs.copyFile(path.join(root, "infra/runtime/installation-packages", oldPackageId, "payload/installer/lms-new-install-worker.cjs"), path.join(directory, "lms-new-install-worker.cjs"));
    await fs.copyFile(path.join(payload, "installer/runtime-process.cjs"), path.join(directory, "runtime-process.cjs"));
    if (mode === "source") await fs.writeFile(path.join(directory, "source-curriculum.cjs"), "exports.curriculumSummary=require('./payload/installer/source-curriculum.cjs').curriculumSummary;");
    const oldWorker = require(path.join(directory, "lms-new-install-worker.cjs"));
    const driver = oldWorker.createInstallDriver(job, { databaseMode: "local_peer", databasePassword: crypto.randomBytes(32).toString("base64url"), clientAdminLogin: "fixture_admin", clientAdminName: "Fixture", clientAdminPassword: crypto.randomBytes(24).toString("base64url"), systemAdminLogin: "fixture_system", systemAdminPassword: crypto.randomBytes(24).toString("base64url") }, payload);
    diagnosticStage = mode + ":validate"; await driver.validate();
    diagnosticStage = mode + ":reserve"; await driver.reserve(); createdApp = true;
    // This acceptance exercises SQL/API/systemd, not the already separate Next compilation scenario.
    const web = path.join(appPath, "releases", packageId, "lms");
    await fs.mkdir(path.join(web, ".next")); await fs.writeFile(path.join(web, ".next/BUILD_ID"), "isolated-runtime-health-fixture");
    await fs.mkdir(path.join(web, "node_modules/next/dist/bin"), { recursive: true });
    await fs.writeFile(path.join(web, "node_modules/next/dist/bin/next"), "require('node:http').createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({protocol:'lms-core-client-v1',clientId:process.env.CORE_RUNTIME_CLIENT_ID,releaseId:process.env.CORE_RUNTIME_RELEASE_ID,storage:'postgresql-runtime'}));}).listen(Number(process.argv.at(-1)),'127.0.0.1');");
    diagnosticStage = mode + ":initialize"; await driver.initialize();
    diagnosticStage = mode + ":bootstrap-failure";
    await assert.rejects(driver.bootstrap(), error => error.code === "CURRICULUM_INSTALL_VERIFY_FAILED");
    await fs.writeFile(path.join(directory, "status.json"), JSON.stringify({ id, clientId, releaseId: packageId, phase: "needs_attention", failedStep: "bootstrap", errorCode: "CURRICULUM_INSTALL_VERIFY_FAILED" }), { mode: 0o600 });
    const shared = path.join(appPath, "shared"), keyBefore = await fs.readFile(path.join(shared, "runtime-vault.key"));
    const secrets = openSecrets(JSON.parse(await fs.readFile(path.join(shared, "runtime-vault.json"))), keyBefore, clientId);
    const accountsSql = ["-XAtw", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", "SELECT md5(encrypted_payload::text)||':'||revision FROM lms_runtime_values WHERE storage_key='core_lms_users_v1'"];
    const accountHash = (await run("runuser", ["-u", "postgres", "--", "psql", ...accountsSql])).stdout;
    diagnosticStage = mode + ":resume";
    const result = await resumeBootstrappedInstallation({ jobId: id, clientId, releaseId: packageId, appPath });
    if (result.phase !== "succeeded") console.log(JSON.stringify({ mode, phase: result.phase, failedStep: result.failedStep, errorCode: result.errorCode }));
    assert.equal(result.phase, "succeeded", JSON.stringify(result));
    assert.deepEqual(await fs.readFile(path.join(shared, "runtime-vault.key")), keyBefore);
    assert.equal((await run("runuser", ["-u", "postgres", "--", "psql", ...accountsSql])).stdout, accountHash);
    for (const service of services) await run("systemctl", ["is-active", "--quiet", service]);
    const read = await fetch(`http://127.0.0.1:${job.apiPort}/api/lms-runtime/v1/read`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secrets.serviceToken}` }, body: JSON.stringify({ keys: ["core_lms_route_v1", "core_lms_tests_v1", "core_lms_users_v1"] }) });
    const rows = (await read.json()).entries; assert.equal(rows[2].data.length, 2);
    for (const row of rows.slice(0, 2)) assert.equal(row.found ? row.data.length : 0, mode === "source" ? 1 : 0);
    await assert.rejects(resumeBootstrappedInstallation({ jobId: id, clientId, releaseId: packageId, appPath }), /RESUME_STAGE_NOT_SUPPORTED/);
    return { mode, realPostgres: true, realApi: true, realSystemd: true, oldFailureReproduced: true, vaultPreserved: true, accountsPreserved: true, curriculumVerified: true, nextBuildInThisTest: false };
  } finally {
    for (const name of services) {
      const file = "/etc/systemd/system/" + name;
      try { const content = await fs.readFile(file, "utf8"); assert.ok(content.includes(appPath)); await run("systemctl", ["disable", "--now", name]); await fs.unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await run("systemctl", ["daemon-reload"]);
    const marker = (await sql(`SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='${database}'`)).stdout.trim();
    if (marker) { assert.equal(marker, `lms-core-db-v1:${clientId}:${id}:ready`); await sql(`DROP DATABASE ${database} WITH (FORCE)`); await sql(`DROP ROLE ${role}`); }
    if (createdApp) { const owner = JSON.parse(await fs.readFile(path.join(appPath, ".core-install-owner.json"))); assert.equal(owner.jobId, id); assert.equal(path.dirname(appPath), "/srv/lms-core/clients"); await run("userdel", [user]); await fs.rm(appPath, { recursive: true }); }
    if (createdJob) { assert.equal(path.dirname(directory), "/srv/lms-core/jobs"); assert.equal(JSON.parse(await fs.readFile(path.join(directory, "job.json"))).job.id, id); await fs.rm(directory, { recursive: true }); }
  }
}

async function main() {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const [packageId, oldPackageId] = process.argv.slice(2); assert.match(packageId || "", /^[a-f0-9-]{36}$/); assert.match(oldPackageId || "", /^[a-f0-9-]{36}$/);
  const results = [];
  for (const mode of ["empty", "source"]) { results.push(await scenario(packageId, oldPackageId, mode)); console.log("accepted real Linux bootstrap recovery: " + mode); }
  const dependencies = {};
  for (const name of ["resume-lms-installation.cjs", "lms-new-install-worker.cjs", "runtime-process.cjs", "source-curriculum.cjs"]) dependencies[name] = digest(await fs.readFile(path.join(root, "infra/scripts", name)));
  const receipt = { accepted: true, checkedAt: new Date().toISOString(), results, fixtureCleaned: true, dependencies };
  await fs.writeFile(path.join(root, "infra/runtime/bootstrap-resume-acceptance.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
}
main().catch(error => { console.error(JSON.stringify({ stage: diagnosticStage, code: error.code || error.message, stderrSignals: ["being used by process", "not found", "does not exist", "permission denied", "cannot be dropped", "does not have a password", "system is not running"].filter(value => String(error.stderr || "").toLowerCase().includes(value)) })); process.exitCode = 1; });
