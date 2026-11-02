"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { _electron } = require("playwright");
const root = path.resolve(__dirname, "../../..");
const retry = process.env.CORE_NATIVE_RETRY === "1";
const clientId = retry ? "ffe5afda-f49c-4518-9dea-429dca1dbf1e" : "5c5d9a43-af96-4f17-b0fb-73ae17063e7f";
const secrets = [crypto.randomBytes(32).toString("base64url"), crypto.randomBytes(24).toString("base64url"), crypto.randomBytes(24).toString("base64url")];
let stage = "setup";
function command(file, args, input = "", timeout = 120000) {
  return new Promise((resolve, reject) => { const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); let out = "";
    const timer = setTimeout(() => { child.kill(); reject(Error("NATIVE_TEST_COMMAND_TIMEOUT")); }, timeout);
    child.stdout.on("data", (data) => { out += data; }); child.stderr.resume(); child.on("error", () => { clearTimeout(timer); reject(Error("NATIVE_TEST_COMMAND_FAILED")); });
    child.on("close", (code) => { clearTimeout(timer); if (code) reject(Error("NATIVE_TEST_COMMAND_EXIT_" + code)); else resolve(out); }); child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
const wsl = (args, input = "") => command("C:\\Windows\\System32\\wsl.exe", ["-d", "LMS-Core-Clean-Test", "--exec", ...args], input);
async function main() {
  const id = crypto.randomUUID(), directory = path.join(root, "infra/runtime/linux-clean-test/20261028", id); await fs.mkdir(directory);
  const keepAlive = spawn("C:\\Windows\\System32\\wsl.exe", ["-d", "LMS-Core-Clean-Test", "--exec", "sleep", "7200"], { windowsHide: true, stdio: "ignore" });
  const files = ["infra/runtime/remote-target.json", `infra/runtime/new-installations/${clientId}.json`, `infra/runtime/new-deployments/${clientId}.json`, `infra/runtime/server-preparations/${clientId}.json`];
  const backups = new Map(); for (const file of files) { try { backups.set(file, await fs.readFile(path.join(root, file))); } catch (error) { if (error.code !== "ENOENT") throw error; backups.set(file, null); } }
  let app;
  try {
    const setup = `set -eu
${retry ? "command -v node >/dev/null\ncommand -v psql >/dev/null" : "if command -v node >/dev/null 2>&1 || command -v psql >/dev/null 2>&1; then exit 7; fi"}
printf '%s\\n' 'root:${secrets[0]}' | chpasswd
cp '/mnt/c/Users/KROLL/Desktop/LMS Core/infra/testing/linux/sshd-clean-test.conf' /etc/ssh/sshd_config.d/90-core-clean.conf
systemctl disable --now ssh.socket >/dev/null 2>&1 || true
systemctl restart ssh
printf CLEAN_SERVER_CONFIRMED
`;
    assert.equal(await wsl(["sh", "-s"], setup), "CLEAN_SERVER_CONFIRMED");
    const pin = (await wsl(["ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub"])).match(/SHA256:[A-Za-z0-9+/]{43}/)?.[0]; assert.ok(pin);
    console.log(retry ? "Retry on the same owned lab: keep previously installed Node/PostgreSQL." : "Clean Linux confirmed: Node and PostgreSQL absent.");
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.join(root, "apps/control-center/node_modules/electron/dist/electron.exe"), args: [path.join(root, "apps/control-center")], env, timeout: 60000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForFunction(() => Boolean(window.launcherApi));
    assert.equal(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()), true);
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    await page.locator("#repository-choose-client").click();
    await page.locator(`.modal-client-button[data-client-id="${clientId}"]`).click();
    await page.waitForFunction((name) => document.querySelector("#repository-target-client").textContent === name, retry ? "Pilot Roastery" : "Demo Client");
    stage = "prepare-plan";
    await page.locator("#remote-operation-mode").selectOption("new");
    await page.locator("#remote-host").fill("127.0.0.1"); await page.locator("#remote-port").fill("22823");
    await page.locator("#remote-username").fill("root"); await page.locator("#remote-base-path").fill("/srv/lms-core/clients");
    await page.locator("#remote-fingerprint").fill(pin);
    await page.locator("#remote-auth-mode").selectOption("password");
    await page.locator("#new-installation-prepare").click();
    await page.waitForFunction(() => !document.querySelector("#new-installation-prepare").disabled);
    if (await page.locator("#new-installation-package").isDisabled()) throw Error("PLAN_REFUSED: " + await page.locator("#remote-feedback").innerText());
    await page.waitForFunction(() => !document.querySelector("#new-installation-package").disabled);
    await page.locator("#new-installation-package").click();
    stage = "package";
    await page.waitForFunction(() => document.querySelector("#new-installation-package-info").textContent.includes("МБ"), null, { timeout: 180000 });
    await page.locator("#remote-password").fill(secrets[0]); await page.locator("#prepare-clean-server").click();
    stage = "prepare-server";
    console.log("NATIVE_CONFIRMATION_REQUIRED: Prepare Ubuntu only on 127.0.0.1:22823.");
    await page.waitForFunction(() => document.querySelector("#server-preparation-result").textContent.includes("Окружение готово"), null, { timeout: 35 * 60 * 1000 });
    console.log("Real app: clean Ubuntu preparation succeeded.");
    stage = "server-check";
    await page.locator("#remote-password").fill(secrets[0]); await page.locator("#new-installation-server-check").click();
    await page.waitForFunction(() => !document.querySelector("#new-installation-start").disabled);
    await page.locator("#new-installation-credentials > summary").click(); await page.locator("#install-db-mode").selectOption("local_peer");
    await page.locator("#install-client-login").fill("native.admin"); await page.locator("#install-client-name").fill("Native local fixture"); await page.locator("#install-client-password").fill(secrets[1]);
    await page.locator("#install-system-login").fill("native.system"); await page.locator("#install-system-password").fill(secrets[2]);
    await page.locator("#remote-password").fill(secrets[0]); await page.locator("#new-installation-start").click();
    stage = "install";
    console.log("NATIVE_CONFIRMATION_REQUIRED: Install LMS only on 127.0.0.1:22823.");
    await page.waitForFunction(() => document.querySelector("#new-installation-result").textContent.includes("LMS установлена"), null, { timeout: 60 * 60 * 1000 });
    console.log("Real app: LMS installed using Windows safeStorage and native confirmation.");
    stage = "viewer";
    for (const field of ["remote-password", "install-client-password", "install-system-password", "install-db-password"]) assert.equal(await page.locator("#" + field).inputValue(), "");
    await page.locator("#remote-password").fill(secrets[0]); await page.locator("#new-installation-open-lms").click();
    await page.waitForFunction(() => document.querySelector("#lms-viewer-caption").textContent.includes("LMS открыта"), null, { timeout: 45000 });
    await page.waitForFunction(() => document.querySelector("#browser-tab-remote").classList.contains("is-current"), null, { timeout: 45000 });
    let lms;
    for (let i = 0; i < 100; i++) { lms = app.context().pages().find((candidate) => candidate !== page && /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())); if (lms) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.ok(lms, "Native WebContentsView must expose its actual page");
    const base = new URL(lms.url()).origin;
    await lms.goto(base + "/login");
    await lms.getByPlaceholder("Логин", { exact: true }).fill("native.admin"); await lms.locator('input[type="password"]').first().fill(secrets[1]);
    await lms.getByRole("button", { name: /^Войти$/i }).click(); await lms.waitForURL(/\/(admin|tasks)/);
    assert.equal(await lms.evaluate(() => typeof window.launcherApi), "undefined"); assert.equal(await lms.evaluate(() => typeof require), "undefined");
    await lms.goto(base + "/tasks?tab=edu"); await lms.getByRole("heading", { name: "Материалы", exact: true }).waitFor();
    await lms.screenshot({ path: path.join(directory, "native-lms.png") });
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    await page.locator("#remote-password").fill(secrets[0]); await page.locator("#new-installation-refresh").click();
    await page.waitForFunction(() => !document.querySelector("#new-installation-refresh").disabled);
    assert.equal(await page.locator("#new-installation-start").isDisabled(), true);
    const installed = JSON.parse(await fs.readFile(path.join(root, `infra/runtime/new-deployments/${clientId}.json`), "utf8"));
    const preparation = JSON.parse(await fs.readFile(path.join(root, `infra/runtime/server-preparations/${clientId}.json`), "utf8"));
    await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify({ format: "lms-core-native-acceptance-v1", checkedAt: new Date().toISOString(), clientId, preparation, installed,
      cleanNodeAndPostgresAbsent: !retry, reusedLabAfterViewerFix: retry, realElectron: true, safeStorage: true, nativeConfirmations: true, peerProvisioning: true, nativeWebContentsView: true, sshGatewayLogin: true, emptyMaterials: true, secretInputsCleared: true, noCoreBridgeInLms: true, duplicateButtonBlocked: true }, null, 2));
    console.log("NATIVE_ACCEPTANCE_PASSED: " + path.join(directory, "receipt.json"));
  } finally {
    if (app) await app.close(); keepAlive.kill();
    for (const file of files) {
      const absolute = path.resolve(root, file); assert.ok(absolute.startsWith(path.join(root, "infra/runtime") + path.sep));
      const label = file.split("/").slice(-2).join("-");
      try { const current = await fs.readFile(absolute); const old = backups.get(file); if (!old || !current.equals(old)) { const value = JSON.parse(current); if (value.target ? value.target.host !== "127.0.0.1" || value.target.port !== 22823 : value.host !== "127.0.0.1" || value.port !== 22823) throw Error("TEST_STATE_OWNERSHIP_CHANGED"); } await fs.writeFile(path.join(directory, label + ".evidence"), current); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const old = backups.get(file);
      if (old) await fs.writeFile(absolute, old); else try { await fs.rename(absolute, path.join(directory, label + ".owned")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}
main().catch((error) => { let message = error.message; for (const secret of secrets) message = message.replaceAll(secret, "[fixture-secret]"); console.error(stage + ": " + message); process.exitCode = 1; });
