"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { _electron } = require("playwright");
const root = path.resolve(__dirname, "../../..");
const evidence = path.join(root, "infra/runtime/linux-clean-test/20261028/2fc34a6e-bd89-4e64-b3fb-f9dd07eecb92");
const clientId = "ffe5afda-f49c-4518-9dea-429dca1dbf1e";
const fixtureId = crypto.randomUUID();
const password = crypto.randomBytes(24).toString("base64url");
const sshPassword = crypto.randomBytes(32).toString("base64url");
const login = "viewer.fixture." + fixtureId.slice(0, 8);
let stage = "setup";
function command(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("C:\\Windows\\System32\\wsl.exe", ["-d", "LMS-Core-Clean-Test", "--exec", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(Error("LOCAL_COMMAND_TIMEOUT")); }, 120000);
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.resume(); child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); reject(Error("LOCAL_COMMAND_FAILED")); });
    child.on("close", (code) => { clearTimeout(timer); code ? reject(Error("LOCAL_COMMAND_EXIT_" + code)) : resolve(output); });
    child.stdin.end(input);
  });
}
async function main() {
  const installed = JSON.parse(await fs.readFile(path.join(evidence, `new-deployments-${clientId}.json.evidence`), "utf8"));
  assert.equal(installed.phase, "succeeded"); assert.equal(installed.target.host, "127.0.0.1"); assert.equal(installed.target.port, 22823);
  assert.equal(installed.target.appPath, "/srv/lms-core/clients/pilot-roastery");
  const directory = path.join(root, "infra/runtime/linux-clean-test/20261028", fixtureId);
  await fs.mkdir(directory);
  const keepAlive = spawn("C:\\Windows\\System32\\wsl.exe", ["-d", "LMS-Core-Clean-Test", "--exec", "sleep", "1800"], { windowsHide: true, stdio: "ignore" });
  const files = ["infra/runtime/remote-target.json", `infra/runtime/new-installations/${clientId}.json`, `infra/runtime/new-deployments/${clientId}.json`];
  const backups = new Map();
  for (const file of files) { try { backups.set(file, await fs.readFile(path.join(root, file))); } catch (error) { if (error.code !== "ENOENT") throw error; backups.set(file, null); } }
  // Only the already-owned local acceptance installation can be seeded. Secrets
  // stay inside the two test processes; neither runtime vault nor account data is printed.
  const accountScript = (remove) => `
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const base='/srv/lms-core/clients/pilot-roastery/shared';
const context=JSON.parse(fs.readFileSync(path.join(base,'runtime-context.json'),'utf8'));
assert.equal(context.clientId,${JSON.stringify(clientId)});assert.equal(context.releaseId,${JSON.stringify(installed.releaseId)});
const {openSecrets}=require('/mnt/c/Users/KROLL/Desktop/LMS Core/infra/scripts/runtime-process.cjs');
const vault=openSecrets(JSON.parse(fs.readFileSync(path.join(base,'runtime-vault.json'),'utf8')),fs.readFileSync(path.join(base,'runtime-vault.key')),context.clientId);
const api='http://127.0.0.1:'+context.apiPort+'/api/lms-runtime/v1';
async function call(action,body){const r=await fetch(api+'/'+action,{method:action==='write'?'PUT':'POST',headers:{Authorization:'Bearer '+vault.serviceToken,'Content-Type':'application/json',Connection:'close'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});assert.equal(r.ok,true,'fixture API status '+r.status);return r.json();}
(async()=>{
const entry=(await call('read',{keys:['core_lms_users_v1']})).entries[0];
assert.equal(entry.found,true);assert.ok(entry.data.some(u=>u.login==='native.admin'&&u.role==='admin'));
${remove ? `const owned=entry.data.filter(u=>u.id===${JSON.stringify(fixtureId)});assert.ok(owned.length<=1);if(owned.length){assert.equal(owned[0].login,${JSON.stringify(login)});await call('write',{key:entry.key,expectedRevision:entry.revision,data:entry.data.filter(u=>u.id!==${JSON.stringify(fixtureId)})});}` : `assert.equal(entry.data.some(u=>u.id===${JSON.stringify(fixtureId)}||u.login===${JSON.stringify(login)}),false);
const salt=crypto.randomBytes(16).toString('hex');const hash='scrypt2$'+salt+'$'+crypto.scryptSync(${JSON.stringify(password)},salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
const admin=entry.data.find(u=>u.login==='native.admin');
await call('write',{key:entry.key,expectedRevision:entry.revision,data:[...entry.data,{...admin,id:${JSON.stringify(fixtureId)},login:${JSON.stringify(login)},passHash:hash,name:'Local viewer acceptance',systemAccount:false}]});`}
process.stdout.write('FIXTURE_${remove ? "REMOVED" : "ADDED"}');
})().catch(()=>{process.stderr.write('FIXTURE_ACCOUNT_OPERATION_FAILED');process.exitCode=1;});`;
  let app, fixtureAdded = false;
  try {
    await command(["sh", "-s"], `set -eu\nprintf '%s\\n' 'root:${sshPassword}' | chpasswd\nsystemctl start ssh\n`);
    // WSL forwards Linux loopback listeners to Windows. Move only this owned
    // fixture away from the Core API port; future local plans reserve 3000-3002.
    if (installed.webPort === 3001) {
      assert.equal(await command(["node", "-"], `const fs=require('node:fs'),assert=require('node:assert/strict'),cp=require('node:child_process');
const file='/srv/lms-core/clients/pilot-roastery/shared/runtime-context.json';const c=JSON.parse(fs.readFileSync(file,'utf8'));
assert.equal(c.clientId,${JSON.stringify(clientId)});assert.equal(c.releaseId,${JSON.stringify(installed.releaseId)});
assert.ok([3001,3010].includes(c.webPort));if(c.webPort===3001){assert.equal(cp.execFileSync('ss',['-H','-ltn','sport = :3010'],{encoding:'utf8'}).trim(),'');c.webPort=3010;fs.writeFileSync(file,JSON.stringify(c));cp.execFileSync('systemctl',['restart','lms-pilot-roastery-web.service']);}process.stdout.write('FIXTURE_PORT_3010');`), "FIXTURE_PORT_3010");
      installed.webPort = 3010;
    }
    assert.equal(await command(["node", "-"], accountScript(false)), "FIXTURE_ADDED"); fixtureAdded = true;
    for (const file of files) {
      const body = file.endsWith("remote-target.json") ? Buffer.from(JSON.stringify(installed.target)) : file.includes("new-deployments/") ? Buffer.from(JSON.stringify(installed)) : await fs.readFile(path.join(evidence, file.split("/").slice(-2).join("-") + ".evidence"));
      await fs.writeFile(path.join(root, file), body);
    }
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(root, "apps/control-center")], env, timeout: 60000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await page.waitForFunction(() => Boolean(window.launcherApi));
    assert.equal(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()), true);
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    await page.locator("#repository-choose-client").click(); await page.locator(`.modal-client-button[data-client-id="${clientId}"]`).click();
    await page.waitForFunction(() => document.querySelector("#repository-target-client").textContent === "Pilot Roastery");
    await page.locator("#remote-operation-mode").selectOption("new");
    stage = "open-viewer";
    await page.locator("#remote-password").fill(sshPassword); await page.locator("#new-installation-open-lms").click();
    await page.waitForFunction(() => document.querySelector("#lms-viewer-caption").textContent.includes("LMS открыта"), null, { timeout: 45000 });
    await page.waitForFunction(() => document.querySelector("#browser-tab-remote").classList.contains("is-current"), null, { timeout: 45000 });
    console.log("Native viewer reported open.");
    let lms;
    for (let i = 0; i < 100; i++) { lms = app.context().pages().find((candidate) => candidate !== page && /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())); if (lms) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    if (!lms) {
      const types = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => ({ type: w.getType(), localhost: /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()) })));
      await fs.writeFile(path.join(directory, "target-diagnostics.json"), JSON.stringify(types));
      throw Error("NATIVE_VIEW_PAGE_NOT_ATTACHED");
    }
    stage = "login";
    const origin = new URL(lms.url()).origin;
    await lms.goto(origin + "/login"); await lms.getByPlaceholder("Логин", { exact: true }).fill(login);
    await lms.locator('input[type="password"]').first().fill(password);
    await lms.getByRole("button", { name: /^Войти$/i }).click(); await lms.waitForURL(/\/(admin|tasks)/);
    assert.equal(await lms.evaluate(() => typeof window.launcherApi), "undefined"); assert.equal(await lms.evaluate(() => typeof require), "undefined");
    await lms.goto(origin + "/tasks?tab=edu"); await lms.getByRole("heading", { name: "Материалы", exact: true }).waitFor();
    await lms.screenshot({ path: path.join(directory, "native-lms.png") });
    stage = "logout-and-close";
    const result = await lms.evaluate(async () => { const r = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); return r.status; });
    assert.equal(result, 200);
    assert.equal(await page.locator("#remote-password").inputValue(), "");
    await page.locator("#close-lms-viewer").click();
    await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(2000) }));
    await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify({ format: "lms-core-native-viewer-acceptance-v1", checkedAt: new Date().toISOString(), installed, realElectron: true, safeStorage: true,
      nativeWebContentsView: true, sshGatewayLogin: true, fixtureAccountViaPrivateSetup: true, originalAccountsUnchanged: true, logout: true, viewerClosed: true, secretInputsCleared: true, noCoreBridgeInLms: true }, null, 2));
    console.log("NATIVE_VIEWER_ACCEPTANCE_PASSED: " + path.join(directory, "receipt.json"));
  } catch (error) {
    await fs.writeFile(path.join(directory, "failure.json"), JSON.stringify({ stage, code: String(error.message).replaceAll(password, "[fixture]").replaceAll(sshPassword, "[fixture]").slice(0, 2000) }));
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    if (fixtureAdded) assert.equal(await command(["node", "-"], accountScript(true)), "FIXTURE_REMOVED");
    for (const file of files) {
      const absolute = path.resolve(root, file); assert.ok(absolute.startsWith(path.join(root, "infra/runtime") + path.sep));
      const old = backups.get(file);
      if (old) await fs.writeFile(absolute, old); else try { await fs.rename(absolute, path.join(directory, file.split("/").slice(-2).join("-") + ".owned")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    keepAlive.kill();
  }
}
main().catch((error) => { console.error(stage + ": " + String(error.message).replaceAll(password, "[fixture]").replaceAll(sshPassword, "[fixture]")); process.exitCode = 1; });
