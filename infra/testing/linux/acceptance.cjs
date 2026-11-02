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

function command(file, args, input = "", timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(Error("LOCAL_TEST_TIMEOUT")); }, timeout);
    child.stdout.on("data", (data) => { out += data; }); child.stderr.on("data", (data) => { err += data; });
    child.on("error", () => { clearTimeout(timer); reject(Error("LOCAL_TEST_PROCESS_FAILED")); });
    child.on("close", (code) => { clearTimeout(timer); if (code) reject(Error(`LOCAL_TEST_COMMAND_FAILED:${path.basename(file)}:${code}`)); else resolve(out); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
const wsl = (args, input = "", timeout) => command("C:\\Windows\\System32\\wsl.exe", ["-d", "LMS-Core-Test", "--exec", ...args], input, timeout);
function verifier(password) {
  const salt = crypto.randomBytes(16), salted = crypto.pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const client = crypto.createHmac("sha256", salted).update("Client Key").digest();
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${crypto.createHash("sha256").update(client).digest("base64")}:${crypto.createHmac("sha256", salted).update("Server Key").digest("base64")}`;
}

async function main() {
  // WSL may idle-stop even with systemd services. Keep only our test distribution awake during acceptance.
  const keepAlive = spawn("C:\\Windows\\System32\\wsl.exe", ["-d", "LMS-Core-Test", "--exec", "sleep", "7200"], { windowsHide: true, stdio: "ignore" });
  try {
  const id = crypto.randomUUID(), clientId = crypto.randomUUID();
  const directory = path.join(root, "infra/runtime/linux-test/20261028", id);
  await fs.mkdir(directory);
  const who = await command("C:\\Windows\\System32\\whoami.exe", ["/user", "/fo", "csv", "/nh"]), sid = who.match(/S-1-\d+(?:-\d+)+/);
  assert.ok(sid); await command("C:\\Windows\\System32\\icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid[0]}:(OI)(CI)F`]);
  const key = path.join(directory, "fixture_key");
  await command("C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe", ["-t", "ed25519", "-f", key, "-N", "", "-C", "lms-core-local-acceptance"]);
  const publicKey = await fs.readFile(key + ".pub", "utf8");
  const adminPassword = crypto.randomBytes(32).toString("base64url");
  const setup = `const fs=require('node:fs');const cp=require('node:child_process');
fs.mkdirSync('/root/.ssh',{recursive:true,mode:0o700});fs.appendFileSync('/root/.ssh/authorized_keys',${JSON.stringify(publicKey)},{mode:0o600});
fs.copyFileSync('/mnt/c/Users/KROLL/Desktop/LMS Core/infra/testing/linux/sshd-test.conf','/etc/ssh/sshd_config.d/90-core-test.conf');
if(fs.existsSync('/srv/lms-core'))fs.chmodSync('/srv/lms-core',0o755);
cp.execFileSync('systemctl',['disable','--now','ssh.socket'],{stdio:'ignore'});cp.execFileSync('systemctl',['restart','ssh']);
cp.execFileSync('runuser',['--user','postgres','--','psql','-v','ON_ERROR_STOP=1','-d','postgres'],{input:${JSON.stringify(`ALTER ROLE postgres PASSWORD '${verifier(adminPassword)}';`)},stdio:['pipe','ignore','ignore']});
process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:child_process').execFileSync('ssh-keygen',['-f','/etc/ssh/ssh_host_ed25519_key.pub','-e','-m','RFC4716'])).digest('hex'));`;
  await wsl(["node", "-"], setup);
  const fp = await wsl(["ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub"]);
  const fingerprint = fp.match(/SHA256:[A-Za-z0-9+/]{43}/)?.[0]; assert.ok(fingerprint);
  const target = { host: "127.0.0.1", port: 22822, username: "root", basePath: "/srv/lms-core/clients", fingerprint };
  const auth = () => ({ mode: "key", identityFile: key });
  const remote = new RemoteTargetService(root);
  const sources = new SourceSnapshotService(root, { withReadAccess: () => { throw Error("Network Git is forbidden in local acceptance"); } }, "C:\\Windows\\System32\\tar.exe");
  const packages = new InstallationPackageService(root, sources);
  const client = { id: clientId, name: "Local Linux acceptance", slug: "linux-test-" + id.slice(0, 8), domain: "local-test.invalid", brandName: "Local fixture", tariff: "base", industryTemplate: "coffee_shop" };
  const detail = { client, profile: { databaseHost: "127.0.0.1", databasePort: 5432 }, adminCredentials: { clientAdminLogin: "fixture.admin", systemAdminLogin: "fixture.system" } };
  const plans = new NewInstallationService(root, sources, remote, async () => detail, packages);
  const plan = await plans.prepare(clientId, "f0140c68-d136-4fe2-aa40-80d9ae2e5185", target);
  console.log("Local plan prepared: " + plan.id);
  await plans.preparePackage(clientId, plan.id);
  const checked = await plans.checkServer(clientId, plan.id, target, auth());
  assert.equal(checked.status, "prepared", JSON.stringify(checked.checks));
  // This DI-only test codec has a memory-only key. Production IPC uses Windows safeStorage.
  const fixtureKey = crypto.randomBytes(32);
  const codec = { available: () => true, encrypt: (text) => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", fixtureKey, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); } };
  const deployment = new NewDeploymentService(root, remote, plans, packages, codec);
  const maintenance = new URL("postgresql://postgres@127.0.0.1:5432/postgres"); maintenance.password = adminPassword;
  const admins = { maintenanceUrl: maintenance.href, clientAdminName: "Local fixture", clientAdminLogin: "fixture.admin", clientAdminPassword: crypto.randomBytes(24).toString("base64url"), systemAdminLogin: "fixture.system", systemAdminPassword: crypto.randomBytes(24).toString("base64url") };
  const loginFixtures = [{ login: admins.clientAdminLogin, password: admins.clientAdminPassword }, { login: admins.systemAdminLogin, password: admins.systemAdminPassword }];
  let previous = "";
  const state = await deployment.start(clientId, plan.id, target, auth(), admins, client, (value) => {
    if (value.phase !== previous) { previous = value.phase; console.log("Linux installation: " + value.phase); }
  });
  assert.equal(state.phase, "succeeded", JSON.stringify(state));
  const unit = `lms-${client.slug}`;
  await wsl(["systemctl", "restart", unit + "-api.service", unit + "-web.service"]);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const health = JSON.parse(await wsl(["curl", "--fail", "--silent", `http://127.0.0.1:${state.webPort}/api/core-runtime/health`]));
  assert.equal(health.clientId, clientId); assert.equal(health.releaseId, state.releaseId);
  const loginCheck = `const assert=require('node:assert/strict');(async()=>{const origin='http://127.0.0.1:${state.webPort}';let cookie='';
for(const credentials of ${JSON.stringify(loginFixtures)}){const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(credentials)});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];}
for(const key of ['tea_hub_dynamic_route_v2','tea_hub_dynamic_tests_v1']){const response=await fetch(origin+'/api/storage?key='+key,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.deepEqual(await response.json(),[]);}
const out=await fetch(origin+'/api/auth/logout',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:'{}'});assert.equal(out.status,200);process.stdout.write('LOGIN_AND_EMPTY_MATERIALS_CONFIRMED');})().catch(()=>{process.stderr.write('LOGIN_ACCEPTANCE_FAILED');process.exitCode=1;});`;
  assert.equal(await wsl(["node", "-"], loginCheck), "LOGIN_AND_EMPTY_MATERIALS_CONFIRMED");
  const reopened = new NewDeploymentService(root, remote, plans, packages, codec);
  assert.equal((await reopened.get(clientId)).id, state.id);
  assert.equal((await reopened.refresh(clientId, target, auth(), () => {})).phase, "succeeded");
  await assert.rejects(reopened.start(clientId, plan.id, target, auth(), admins, client, () => {}));
  const receipt = { format: "lms-core-linux-acceptance-v1", distro: "LMS-Core-Test", os: "Ubuntu 24.04", node: "22", postgres: "16", jobId: state.id, clientId, releaseId: state.releaseId,
    installationSucceeded: true, servicesRestarted: true, clientAndSystemLogin: true, emptyMaterials: true, logout: true, resultReopened: true, duplicateRefused: true, checkedAt: new Date().toISOString(), target, appPath: state.target.appPath };
  await fs.writeFile(path.join(directory, "acceptance.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ receipt: path.join(directory, "acceptance.json"), state: state.phase, clientId, appPath: state.target.appPath }));
  } finally { keepAlive.kill(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
