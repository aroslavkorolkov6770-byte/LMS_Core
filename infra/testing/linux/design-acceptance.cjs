"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../../..");
const { RemoteTargetService } = require(path.join(root, "apps/control-center/dist/remote-target.js"));
const { SourceSnapshotService } = require(path.join(root, "apps/control-center/dist/source-snapshots.js"));
const { InstallationPackageService } = require(path.join(root, "apps/control-center/dist/installation-package.js"));
const { NewInstallationService } = require(path.join(root, "apps/control-center/dist/new-installation.js"));
const { NewDeploymentService } = require(path.join(root, "apps/control-center/dist/new-deployment.js"));
const { fixtureKeyRemovalScript } = require("./design-test-cleanup.cjs");

function command(file, args, input = "", timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errorOutput = "";
    const timer = setTimeout(() => { child.kill(); reject(Error("LOCAL_DESIGN_TIMEOUT")); }, timeout);
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-4096); });
    child.once("error", () => { clearTimeout(timer); reject(Error("LOCAL_DESIGN_PROCESS_FAILED")); });
    child.once("close", (code) => { clearTimeout(timer); const detail = errorOutput.match(/DESIGN_ACCEPTANCE_FAILED:[a-z_-]+/)?.[0] || ""; code ? reject(Error(`LOCAL_DESIGN_COMMAND_FAILED:${path.basename(file)}:${code}${detail ? ":" + detail : ""}`)) : resolve(output); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
const distro = "LMS-Core-Test";
const wsl = (args, input = "") => command("C:\\Windows\\System32\\wsl.exe", ["-d", distro, "--exec", ...args], input);
async function cleanupCommand(args, input = "") {
  // WSL can reject one invocation while starting its root user session. Retry only idempotent fixture cleanup, never an installation.
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await wsl(args, input); } catch (error) { failure = error; }
  }
  throw failure;
}

(async () => {
  assert.ok(process.env.CORE_TEST_DESIGN_PACKAGES || process.env.CORE_TEST_POINT_PACKAGE);
  const point = process.env.CORE_TEST_POINT_PACKAGE ? JSON.parse(await fs.readFile(process.env.CORE_TEST_POINT_PACKAGE, "utf8")) : null;
  if (point) assert.equal(point.previewEqualsPayload, true);
  const entry = point ? { artifact: point.artifact, clientId: point.clientId, label: "Point Linux fixture" } : JSON.parse(await fs.readFile(process.env.CORE_TEST_DESIGN_PACKAGES, "utf8")).packages[0];
  const artifact = entry.artifact, clientId = entry.clientId;
  const design = JSON.parse(await fs.readFile(path.join(artifact.payloadPath, "lms/core-client-design.json"), "utf8"));
  assert.equal(artifact.design.clientId, clientId);
  const fixtureId = crypto.randomUUID(), slug = `design-${fixtureId.slice(0, 8)}`;
  const directory = path.join(root, "infra/runtime/linux-test/20261029", fixtureId);
  await fs.mkdir(directory, { recursive: true });
  const keepAlive = spawn("C:\\Windows\\System32\\wsl.exe", ["-d", distro, "--exec", "sleep", "7200"], { windowsHide: true, stdio: "ignore" });
  let publicKey = "", unitsCreated = false, result;
  try {
    const who = await command("C:\\Windows\\System32\\whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = who.match(/S-1-\d+(?:-\d+)+/); assert.ok(sid);
    await command("C:\\Windows\\System32\\icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid[0]}:(OI)(CI)F`]);
    const key = path.join(directory, "fixture_key");
    await command("C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe", ["-t", "ed25519", "-f", key, "-N", "", "-C", `core-design-test-${fixtureId}`]);
    publicKey = await fs.readFile(key + ".pub", "utf8");
    await wsl(["node", "-"], `const fs=require('node:fs'),cp=require('node:child_process');fs.mkdirSync('/root/.ssh',{recursive:true,mode:0o700});fs.appendFileSync('/root/.ssh/authorized_keys',${JSON.stringify(publicKey)},{mode:0o600});cp.execFileSync('systemctl',['start','ssh','postgresql']);`);
    const fingerprint = (await wsl(["ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub"])).match(/SHA256:[A-Za-z0-9+/]{43}/)?.[0]; assert.ok(fingerprint);
    const target = { host: "127.0.0.1", port: 22822, username: "root", basePath: "/srv/lms-core/clients", fingerprint };
    const auth = () => ({ mode: "key", identityFile: key });
    const sources = new SourceSnapshotService(root, { withReadAccess: () => { throw Error("External Git disabled"); } }, "C:\\Windows\\System32\\tar.exe");
    const packages = new InstallationPackageService(root, sources), remote = new RemoteTargetService(root);
    const client = { id: clientId, slug, name: entry.label, brandName: design.brandName || entry.label, domain: "design-test.invalid", tariff: "base", industryTemplate: "coffee_shop" };
    const detail = { client, profile: { databaseHost: "127.0.0.1", databasePort: 5432 }, adminCredentials: { clientAdminLogin: "design.admin", systemAdminLogin: "design.system" } };
    const reference = { id: artifact.design.id, version: artifact.design.version, clientId, sha256: artifact.design.sha256, source: "saved" };
    const designs = { capture: async () => reference, currentHash: async () => reference.sha256, read: async () => design };
    const points = design.version === 3 ? { captureOptional: async () => reference, currentHash: async () => reference.sha256, hasChanges: async () => true } : undefined;
    const plans = new NewInstallationService(root, sources, remote, async () => detail, { prepare: async () => artifact, verify: (value, snapshot) => packages.verify(value, snapshot) }, designs, points);
    const plan = await plans.prepare(clientId, "f0140c68-d136-4fe2-aa40-80d9ae2e5185", target, design.version === 3 ? "source" : "custom");
    await plans.preparePackage(clientId, plan.id);
    assert.equal((await plans.checkServer(clientId, plan.id, target, auth())).status, "prepared");
    const memoryKey = crypto.randomBytes(32);
    const codec = { available: () => true, encrypt: (text) => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", memoryKey, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); } };
    const deployment = new NewDeploymentService(root, remote, plans, packages, codec, undefined, undefined, designs.currentHash);
    const admins = { databaseMode: "local_peer", clientAdminName: "Local design fixture", clientAdminLogin: "design.admin", clientAdminPassword: crypto.randomBytes(24).toString("base64url"), systemAdminLogin: "design.system", systemAdminPassword: crypto.randomBytes(24).toString("base64url") };
    const credentials = [{ login: admins.clientAdminLogin, password: admins.clientAdminPassword }, { login: admins.systemAdminLogin, password: admins.systemAdminPassword }];
    let phase = "";
    const state = await deployment.start(clientId, plan.id, target, auth(), admins, client, (value) => { if (phase !== value.phase) { phase = value.phase; console.log(`Local Linux design: ${phase}`); } });
    assert.equal(state.phase, "succeeded", JSON.stringify(state));
    unitsCreated = true;
    console.log("Local Linux design: restart owned fixture services");
    await cleanupCommand(["systemctl", "restart", `lms-${slug}-api.service`, `lms-${slug}-web.service`]);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const check = `const assert=require('node:assert/strict');let stage='health';(async()=>{const origin='http://127.0.0.1:${state.webPort}';
const health=await (await fetch(origin+'/api/core-runtime/health')).json();assert.equal(health.clientId,${JSON.stringify(clientId)});
stage='markup';
const html=await (await fetch(origin+'/login')).text();for(const text of ${JSON.stringify(design.version === 3 ? [design.format, ...Object.values(design.elements).map((element) => element.text).filter(Boolean)] : [design.content.homeTitle, design.content.loginTitle, design.typography.headingFont, design.theme.primary])})assert.ok(html.includes(text));
stage='assets';
for(const asset of ${JSON.stringify(design.assets || [])}){const r=await fetch(origin+'/'+asset.path);assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),asset.sha256);}
stage='login';
let cookie='';for(const credentials of ${JSON.stringify(credentials)}){const r=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(credentials)});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];}
stage='empty-materials';for(const key of ['tea_hub_dynamic_route_v2','tea_hub_dynamic_tests_v1']){const r=await fetch(origin+'/api/storage?key='+key,{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.deepEqual(await r.json(),[]);}process.stdout.write('DESIGN_LOGIN_RESTART_EMPTY_CONFIRMED');})().catch(()=>{process.stderr.write('DESIGN_ACCEPTANCE_FAILED:'+stage);process.exitCode=1;});`;
    console.log("Local Linux design: verify restarted fixture");
    assert.equal(await cleanupCommand(["node", "-"], check), "DESIGN_LOGIN_RESTART_EMPTY_CONFIRMED");
    console.log("Local Linux design: runtime, images and both logins verified");
    const context = JSON.parse(await cleanupCommand(["cat", `${state.target.appPath}/shared/runtime-context.json`]));
    assert.equal(context.designSha256, reference.sha256);
    result = { checkedAt: new Date().toISOString(), distro, clientId, packageId: artifact.id, designVersion: design.version, designSha256: reference.sha256, assetCount: design.assets?.length || 0, appPath: state.target.appPath, installedThroughCoreServices: true, jobVersion: 2, productionLinuxBuild: true, systemdRestart: true, bothAdminsLogin: true, emptyMaterials: true, designServed: true, externalDeployment: false, pointMode: design.version === 3, cleanupScope: "Owned systemd services disabled; temporary SSH key removed; installed fixture files/database retained in isolated Linux for diagnostics." };
  } finally {
    try {
      if (unitsCreated) { console.log("Local Linux design: stop owned services"); await cleanupCommand(["systemctl", "disable", "--now", `lms-${slug}-api.service`, `lms-${slug}-web.service`]); }
    } finally {
      try {
        if (publicKey) { console.log("Local Linux design: remove temporary fixture key"); await cleanupCommand(["node", "-"], fixtureKeyRemovalScript(publicKey)); }
      } finally { keepAlive.kill(); }
    }
  }
  result.cleanupCompleted = true;
  await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, result }));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
