"use strict";
const path = require("node:path"), fs = require("node:fs/promises");
const { app, safeStorage } = require("electron");
app.setPath("userData", path.join(app.getPath("appData"), "@lms-core/control-center"));
const root = path.resolve(__dirname, "../..");
const { ClientServerStore } = require(path.join(root, "apps/control-center/dist/client-servers.js"));
const { ClientInstallationAccessStore } = require(path.join(root, "apps/control-center/dist/client-installation-access.js"));
const { RemoteTargetService } = require(path.join(root, "apps/control-center/dist/remote-target.js"));
const { NewDeploymentService } = require(path.join(root, "apps/control-center/dist/new-deployment.js"));

app.whenReady().then(async () => {
  const [clientId, host, expectedJobId] = process.argv.slice(2);
  if (![clientId, expectedJobId].every(value => /^[a-f0-9-]{36}$/.test(value || ""))) throw Error("INVALID_TARGET");
  const state = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/new-deployments", clientId + ".json"), "utf8"));
  if (state.clientId !== clientId || state.id !== expectedJobId || state.phase !== "needs_attention" || state.errorCode !== "CURRICULUM_INSTALL_VERIFY_FAILED" ||
      state.target.host !== host || state.target.username !== "root" || !state.target.fingerprint) throw Error("TARGET_CHANGED");
  const protector = { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) };
  const store = new ClientServerStore(path.join(app.getPath("userData"), "client-servers"), protector);
  const access = new ClientInstallationAccessStore(path.join(app.getPath("userData"), "installation-access"), protector);
  const remote = new RemoteTargetService(root, undefined, async (target, auth) => (await store.get(clientId, target)).passwordSaved ? store.credentials(target, auth) : access.sshCredentials(target, auth));
  // Use the same service, acceptance gate, state persistence and SSH transport as Core's recovery button.
  const service = new NewDeploymentService(root, remote, { get: async () => null }, {}, protector, undefined, async target => target.host === host && target.fingerprint === state.target.fingerprint);
  const result = await service.recover(clientId, state.target, { mode: "password", savedForClient: clientId }, () => {});
  const directory = path.join(root, "infra/runtime/reinstall-recovery"); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, clientId + ".json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); app.exit(result.phase === "succeeded" ? 0 : 1);
}).catch(() => { console.error("BOOTSTRAP_RESUME_UNCONFIRMED"); app.exit(1); });
