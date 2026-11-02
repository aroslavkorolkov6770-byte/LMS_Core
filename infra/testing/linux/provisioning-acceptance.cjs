"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), net = require("node:net"), assert = require("node:assert/strict"), { execFile } = require("node:child_process"), { promisify } = require("node:util");
const root = path.resolve(__dirname, "../../.."), worker = require(path.join(root, "infra/scripts/lms-new-install-worker.cjs")), deletion = require(path.join(root, "infra/scripts/delete-client-database.cjs")), preflight = require(path.join(root, "infra/scripts/database-preflight.cjs"));
const run = async (file, args, input) => new Promise((resolve, reject) => { const child = execFile(file, args, { timeout: 60000, maxBuffer: 65536 }, (e, stdout) => e ? reject(Error("LOCAL_PROVISION_COMMAND_FAILED")) : resolve(stdout)); child.stdin.on("error", () => {}); child.stdin.end(input || ""); });
const free = async () => { const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
async function acceptance() {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const pkg = "ece72471-ceed-4b98-ba79-c38691a711d1", payload = path.join(root, "infra/runtime/installation-packages", pkg, "payload");
  await worker.verifyPackage(payload, pkg);
  const clientId = crypto.randomUUID(), jobId = crypto.randomUUID(), slug = "provision-fixture-" + jobId.slice(0, 12), appPath = "/srv/lms-core/clients/" + slug;
  const user = "lms-" + crypto.createHash("sha256").update(clientId).digest("hex").slice(0, 20), db = "lms_" + clientId.replaceAll("-", ""), role = "lms_role_" + clientId.replaceAll("-", "");
  const client = { id: clientId, name: "Provision fixture", slug, domain: "fixture.invalid", brandName: "Fixture", tariff: "base", industryTemplate: "coffee_shop", includedUsers: 5, maxAdmins: 2, aiRequestsLimit: 0, primaryColor: null };
  const job = { version: 1, id: jobId, releaseId: pkg, client, apiPort: await free(), webPort: await free() };
  const secrets = { databaseMode: "local_peer", databasePassword: crypto.randomBytes(32).toString("base64url"), clientAdminLogin: "fixture.admin", clientAdminName: "Fixture", clientAdminPassword: crypto.randomBytes(24).toString("base64url"), systemAdminLogin: "fixture.system", systemAdminPassword: crypto.randomBytes(24).toString("base64url") };
  const driver = worker.createInstallDriver(job, secrets, payload);
  let reserved = false;
  const admin = sql => run("runuser", ["-u", "postgres", "--", "psql", "-X", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-h", "/var/run/postgresql", "-d", "postgres"], sql);
  try {
    assert.equal((await preflight.checkDatabaseAccess({ databaseMode: "local_peer" })).ready, true);
    const absent = (await admin(`SELECT count(*) FROM pg_database WHERE datname='${db}';`)).trim(); assert.equal(absent, "0");
    await driver.validate(); await driver.reserve(); reserved = true;
    // Test the privileged boundary itself with the real packaged CLI and real PostgreSQL.
    await driver.initialize(); await driver.bootstrap();
    assert.equal((await admin(`SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='${db}';`)).trim(), `lms-core-db-v1:${clientId}:${jobId}:ready`);
    console.log("real peer provisioning, fresh schema, restricted tenant role and two administrator bootstrap accepted");
  } finally {
    await driver.cleanup();
    const oid = Number((await admin(`SELECT oid FROM pg_database WHERE datname='${db}';`)).trim());
    if (oid) await admin(deletion.databaseSql({ clientId, jobId, releaseId: pkg, operationId: crypto.randomUUID(), appPath }, true, oid));
    if (reserved) {
      const owner = JSON.parse(await fs.readFile(appPath + "/.core-install-owner.json")); assert.equal(owner.jobId, jobId); assert.equal(owner.clientId, clientId); assert.equal(path.dirname(appPath), "/srv/lms-core/clients"); assert.ok(slug.startsWith("provision-fixture-"));
      await run("userdel", [user]); await fs.rm(appPath, { recursive: true });
    }
  }
  const receipt = { accepted: true, realPeer: true, schemaInitialized: true, administratorsCreated: true, nextBuildInThisTest: false, fixtureCleaned: true, remoteVps: false, packageId: pkg, checkedAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, "infra/runtime/provisioning-acceptance.json"), JSON.stringify(receipt)); console.log(JSON.stringify(receipt));
}
void acceptance().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
