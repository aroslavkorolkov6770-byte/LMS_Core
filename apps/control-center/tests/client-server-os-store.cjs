"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const A = "11111111-1111-4111-8111-111111111111";
const target = { host: "fixture.invalid", port: 22, username: "root", basePath: "/srv/lms-core/clients", fingerprint: "SHA256:" + "a".repeat(43) };
const secret = "local-fixture-credential-not-a-real-password";

async function electronPhase() {
  const { app, safeStorage } = require("electron");
  const root = process.argv[2], phase = process.argv[3];
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("core-os-credential-")) throw Error("UNSAFE_FIXTURE");
  app.setPath("userData", path.join(root, "electron-profile"));
  await app.whenReady();
  const { ClientServerStore } = require("../dist/client-servers.js");
  const store = new ClientServerStore(path.join(root, "servers"), { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
  assert.equal(process.platform, "win32");
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  if (phase === "write") {
    const saved = await store.remember(A, target, secret, 0);
    assert.equal(saved.passwordSaved, true);
    assert.ok(!(await fs.readFile(path.join(root, "servers", `${A}.json`), "utf8")).includes(secret));
  } else if (phase === "read") {
    assert.equal((await store.get(A)).passwordSaved, true);
    assert.equal((await store.credentials(target, { mode: "password", savedForClient: A })).password, secret);
    await store.forget(A, target, 1);
  } else if (phase === "forgotten") {
    assert.equal((await store.get(A)).passwordSaved, false);
    await assert.rejects(store.credentials(target, { mode: "password", savedForClient: A }));
  } else throw Error("INVALID_FIXTURE_PHASE");
  await new Promise(resolve => process.stdout.write(`CORE_OS_STORE:${phase}:ok\n`, resolve));
  app.quit();
}

async function orchestrate() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-os-credential-"));
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    for (const phase of ["write", "read", "forgotten"]) {
      const result = await promisify(execFile)(require("electron"), [__filename, root, phase], { env, windowsHide: true, timeout: 30000, maxBuffer: 65536 });
      assert.ok(result.stdout.includes(`CORE_OS_STORE:${phase}:ok`));
      assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    }
    process.stdout.write("Windows DPAPI acceptance passed: real Electron encrypt; separate-process restart/decrypt; unlock; next-process forget. Isolated fixture only, no SSH.\n");
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("core-os-credential-")) throw Error("UNSAFE_FIXTURE_CLEANUP");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
if (process.versions.electron) void electronPhase().catch(() => { process.stderr.write("CORE_OS_STORE_FAILED\n"); require("electron").app.exit(1); });
else void orchestrate().catch(error => { process.stderr.write(`OS store acceptance failed: ${error.code || "fixture assertion"}\n`); process.exitCode = 1; });
