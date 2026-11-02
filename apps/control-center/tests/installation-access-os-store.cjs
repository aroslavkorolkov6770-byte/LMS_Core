"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const A = "11111111-1111-4111-8111-111111111111";
const secret = "isolated-generated-fixture-not-server-password";
async function phase() {
  const { app, safeStorage } = require("electron");
  const root = process.argv[2], mode = process.argv[3];
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("core-install-access-")) throw Error("UNSAFE_FIXTURE");
  app.setPath("userData", path.join(root, "electron-profile")); await app.whenReady();
  const { ClientInstallationAccessStore } = require("../dist/client-installation-access.js");
  assert.equal(process.platform, "win32"); assert.equal(safeStorage.isEncryptionAvailable(), true);
  const store = new ClientInstallationAccessStore(path.join(root, "vault"), { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
  if (mode === "write") {
    await store.save(A, { clientAdminName: "Fixture", clientAdminLogin: "admin", clientAdminPassword: secret, systemAdminLogin: "system_admin", systemAdminPassword: secret + "s", host: "192.0.2.11", sshUsername: "root", sshPort: 22, sshPassword: secret + "ssh", databaseMode: "local_peer", databaseHost: "192.0.2.11", databasePort: 5432, databaseUser: "postgres", databasePassword: "" }, 0);
    assert.ok(!(await fs.readFile(path.join(root, "vault", A + ".json"), "utf8")).includes(secret));
  } else if (mode === "read") {
    const meta = await store.get(A); assert.equal(meta.saved.clientAdminPassword, true); assert.ok(!JSON.stringify(meta).includes(secret));
    const result = await store.resolve(A, { useSavedAccess: true, clientAdminLogin: "admin", systemAdminLogin: "system_admin" }, { clientAdminLogin: "admin", systemAdminLogin: "system_admin" });
    assert.equal(result.clientAdminPassword, secret); assert.equal(result.systemAdminPassword, secret + "s"); await store.forgetSsh(A);
  } else if (mode === "forgotten") { const meta = await store.get(A); assert.equal(meta.saved.sshPassword, false); assert.equal(meta.saved.systemAdminPassword, true); await store.remove(A); }
  else throw Error("INVALID_MODE");
  await new Promise(resolve => process.stdout.write(`CORE_INSTALL_ACCESS:${mode}:ok\n`, resolve)); app.quit();
}
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-install-access-"));
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    for (const mode of ["write", "read", "forgotten"]) {
      const result = await promisify(execFile)(require("electron"), [__filename, root, mode], { env, windowsHide: true, timeout: 30000, maxBuffer: 65536 });
      assert.ok(result.stdout.includes(`CORE_INSTALL_ACCESS:${mode}:ok`)); assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    }
    process.stdout.write("Installation access DPAPI accepted: real encryption, separate process reopen, metadata redaction, SSH forget without losing admin passwords. No real client or SSH.\n");
  } finally { if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("core-install-access-")) throw Error("UNSAFE_CLEANUP"); await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); }
}
if (process.versions.electron) void phase().catch(() => { process.stderr.write("CORE_INSTALL_ACCESS_FAILED\n"); require("electron").app.exit(1); });
else void main().catch(() => { process.stderr.write("Installation access OS acceptance failed\n"); process.exitCode = 1; });
