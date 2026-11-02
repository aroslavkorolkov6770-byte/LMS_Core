"use strict";
const path = require("node:path"), fs = require("node:fs/promises");
const { app, safeStorage } = require("electron");
app.setPath("userData", path.join(app.getPath("appData"), "@lms-core/control-center"));
const root = path.resolve(__dirname, "../..");
const { ClientServerStore } = require(path.join(root, "apps/control-center/dist/client-servers.js"));
const { ClientInstallationAccessStore } = require(path.join(root, "apps/control-center/dist/client-installation-access.js"));
const { RemoteTargetService } = require(path.join(root, "apps/control-center/dist/remote-target.js"));

// Inspect public job metadata only. Never return the vault, credentials, account rows or private logs.
async function inspect(input) {
  const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
  const directory = `/srv/lms-core/jobs/${input.id}`;
  const config = JSON.parse(await fs.readFile(path.join(directory, "job.json"), "utf8"));
  if (config.job.id !== input.id || config.job.client.id !== input.clientId || config.job.releaseId !== input.releaseId ||
      input.appPath !== `/srv/lms-core/clients/${config.job.client.slug}`) throw Error("JOB_IDENTITY_CHANGED");
  const status = JSON.parse(await fs.readFile(path.join(directory, "status.json"), "utf8"));
  const owner = JSON.parse(await fs.readFile(path.join(input.appPath, ".core-install-owner.json"), "utf8"));
  if (owner.jobId !== input.id || owner.clientId !== input.clientId || owner.releaseId !== input.releaseId) throw Error("OWNER_CHANGED");
  const files = {};
  for (const name of ["source-curriculum.cjs", "payload/installer/source-curriculum.cjs", "payload/release-manifest.json"]) {
    try {
      const file = path.join(directory, name), stat = await fs.lstat(file);
      files[name] = { present: true, regular: stat.isFile() && !stat.isSymbolicLink(), uid: stat.uid, mode: (stat.mode & 0o777).toString(8),
        sha256: crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex") };
    } catch (error) { if (error.code !== "ENOENT") throw error; files[name] = { present: false }; }
  }
  const sharedFiles = await fs.readdir(path.join(input.appPath, "shared"));
  return { readOnly: true, id: input.id, releaseId: input.releaseId, clientId: input.clientId,
    contentMode: config.job.contentMode, phase: status.phase, failedStep: status.failedStep, errorCode: status.errorCode,
    ownerState: owner.state, files, vaultFilesPresent: ["runtime-vault.key", "runtime-vault.json", "runtime-context.json"].every(name => sharedFiles.includes(name)),
    contentReceiptPresent: sharedFiles.includes("content-receipt.json") };
}

app.whenReady().then(async () => {
  const [clientId, host] = process.argv.slice(2);
  if (!/^[a-f0-9-]{36}$/.test(clientId || "")) throw Error("INVALID_CLIENT");
  const state = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/new-deployments", clientId + ".json"), "utf8"));
  if (state.clientId !== clientId || state.target.host !== host || state.target.username !== "root" || !state.target.fingerprint) throw Error("TARGET_CHANGED");
  const protector = { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) };
  const store = new ClientServerStore(path.join(app.getPath("userData"), "client-servers"), protector);
  const access = new ClientInstallationAccessStore(path.join(app.getPath("userData"), "installation-access"), protector);
  const remote = new RemoteTargetService(root, undefined, async (target, auth) => (await store.get(clientId, target)).passwordSaved ? store.credentials(target, auth) : access.sshCredentials(target, auth));
  const input = { id: state.id, clientId, releaseId: state.releaseId, appPath: state.target.appPath };
  const script = `(${inspect.toString()})(${JSON.stringify(input)}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>process.stdout.write(JSON.stringify({readOnly:true,errorCode:/^[A-Z_]+$/.test(e.message)?e.message:'INSPECTION_FAILED'})));`;
  console.log(await remote.withSession(state.target, { mode: "password", savedForClient: clientId }, session => session.execute("node -", script, 30000)));
  app.exit(0);
}).catch(() => { console.error("FAILED_BOOTSTRAP_INSPECTION_FAILED"); app.exit(1); });
