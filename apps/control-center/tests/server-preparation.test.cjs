const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { ServerPreparationService } = require("../dist/server-preparation.js");
const { validateSecrets } = require("../../../infra/scripts/lms-new-install-worker.cjs");
const { runRuntimeProvisioning } = require("../../api/dist/runtime-provision.js");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "/bin/sh";
const posix = (value) => process.platform === "win32" ? `/${value[0].toLowerCase()}${value.slice(2).replace(/\\/g, "/")}` : value;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function memoryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-memory-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-memory-")); await fs.rm(root, { recursive: true, force: true }); });
  const bin = path.join(root, "bin"), info = path.join(root, "meminfo"), audit = path.join(root, "calls"), active = path.join(root, "active");
  await fs.mkdir(bin); await fs.mkdir(path.join(root, "systemd"));
  await fs.writeFile(path.join(root, "os-release"), "ID=ubuntu\nVERSION_ID=24.04\n");
  await fs.writeFile(info, "MemTotal: 984208 kB\nSwapTotal: 524284 kB\n");
  await fs.writeFile(path.join(root, "disk"), "20000000"); await fs.writeFile(path.join(root, "fstype"), "ext2/ext3");
  const files = {
    id: "printf '0\\n'", uname: "printf 'x86_64\\n'", flock: "exit 0",
    // Windows fixtures emulate POSIX metadata and kernel swap; they never allocate or activate real swap.
    mkdir: 'if [ "$1" = -m ]; then shift; shift; fi; exec /usr/bin/mkdir "$@"', chmod: "exit 0",
    stat: `if [ "$1" = -f ]; then cat ${quote(posix(path.join(root, "fstype")))}; elif [ "$2" = %u ]; then printf 0; elif [ "$2" = %a ]; then if [ -d "$3" ]; then printf 755; else printf 600; fi; elif [ "$2" = %s ] && [ "\${3##*/}" = build-4g.swap ]; then printf 4294967296; else /usr/bin/stat "$@"; fi`,
    df: `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fixture 40000000 1 %s 1%% /fixture\\n' "$(cat ${quote(posix(path.join(root, "disk")))})"`,
    dd: `printf 'allocate\\n' >> ${quote(posix(audit))}; for argument do case "$argument" in of=*) file=\${argument#of=};; esac; done; printf 'fixture-not-real-4gb' > "$file"`,
    mkswap: `printf 'initialize\\n' >> ${quote(posix(audit))}`,
    swapon: `if [ "$1" = --show ]; then if [ -e ${quote(posix(active))} ]; then cat ${quote(posix(active))}; fi; else printf '%s\\n' "$1" > ${quote(posix(active))}; printf 'activate\\n' >> ${quote(posix(audit))}; printf 'MemTotal: 984208 kB\\nSwapTotal: 4718592 kB\\n' > ${quote(posix(info))}; fi`
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  const source = await fs.readFile(path.resolve(__dirname, "../../../infra/scripts/prepare-build-memory.sh"), "utf8");
  const script = source.replace("export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", `export PATH=${quote(posix(bin))}:/usr/bin:/bin`)
    .replaceAll("/srv", posix(path.join(root, "server"))).replaceAll("/etc/os-release", posix(path.join(root, "os-release"))).replaceAll("/proc/meminfo", posix(info)).replaceAll("/run/systemd/system", posix(path.join(root, "systemd")));
  const inspect = async () => {
    const result = await run(shell, [...(process.env.CORE_TEST_MEMORY_TRACE === "1" ? ["-x"] : []), "-c", script], { timeout: 15000, windowsHide: true });
    if (process.env.CORE_TEST_MEMORY_TRACE === "1") process.stderr.write(result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, info, audit, active, inspect, file: path.join(root, "server/lms-core/memory/build-4g.swap"), marker: path.join(root, "server/lms-core/memory/build-4g.owner") };
}

test("swap shell fixture creates once, reuses only its initialized file after a simulated reboot, and never changes fstab", async (t) => {
  const f = await memoryFixture(t);
  const first = await f.inspect(); assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.created, 1);
  const before = await fs.readFile(f.file);
  assert.equal((await f.inspect()).created, 0);
  await fs.writeFile(f.info, "MemTotal: 984208 kB\nSwapTotal: 524284 kB\n"); await fs.unlink(f.active);
  const resumed = await f.inspect(); assert.equal(resumed.ok, true); assert.equal(resumed.reused, 1); assert.equal(resumed.created, 0);
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal((await fs.readFile(f.audit, "utf8")).split("\n").filter((line) => line === "allocate").length, 1);
  const script = await fs.readFile(path.resolve(__dirname, "../../../infra/scripts/prepare-build-memory.sh"), "utf8");
  assert.ok(!/swapoff|>>?\s*['"]?\/etc\/fstab|\brm\s|apt-get/.test(script));
  assert.ok(script.includes("943718400") && script.includes("3221225472") && script.includes("11811160064"));
});

test("swap shell fixture rejects an occupied file without rewriting it", async (t) => {
  const f = await memoryFixture(t); await fs.mkdir(path.dirname(f.file), { recursive: true }); await fs.writeFile(f.file, "foreign-file");
  assert.equal((await f.inspect()).code, "SWAP_FILE_OCCUPIED"); assert.equal(await fs.readFile(f.file, "utf8"), "foreign-file");
  await assert.rejects(fs.stat(f.audit), { code: "ENOENT" });
});

test("swap shell fixture rejects low RAM, insufficient disk and unsupported filesystem before allocation", async (t) => {
  const f = await memoryFixture(t);
  await fs.writeFile(f.info, "MemTotal: 800000 kB\nSwapTotal: 0 kB\n"); assert.equal((await f.inspect()).code, "RAM_TOO_LOW");
  await fs.writeFile(f.info, "MemTotal: 984208 kB\nSwapTotal: 524284 kB\n");
  await fs.writeFile(path.join(f.root, "disk"), "1000000"); assert.equal((await f.inspect()).code, "SWAP_DISK_LOW");
  await fs.writeFile(path.join(f.root, "fstype"), "overlayfs"); assert.equal((await f.inspect()).code, "SWAP_FILESYSTEM_UNSUPPORTED");
  await assert.rejects(fs.stat(f.audit), { code: "ENOENT" });
});

test("both preparation guards accept Ubuntu 24.04/26.04 and reject other releases before package changes", async t => {
  const f = await memoryFixture(t), osFile = path.join(f.root, "os-release");
  for (const version of ["24.04", "26.04", "25.10"]) {
    await fs.writeFile(osFile, `ID=ubuntu\nVERSION_ID=${version}\n`);
    await fs.writeFile(f.info, "MemTotal: 1000000 kB\nSwapTotal: 4000000 kB\n");
    const memory = await f.inspect();
    assert.equal(memory.ok, version !== "25.10");
    const source = await fs.readFile(path.resolve(__dirname, "../../../infra/scripts/prepare-clean-server.sh"), "utf8");
    const guard = source.split(/\r?\n/).find(line => line.startsWith('[ "${ID:-}" = ubuntu ]'));
    assert.ok(guard);
    const script = `PATH=${quote(posix(path.join(f.root, "bin")))}:/usr/bin:/bin\n. ${quote(posix(osFile))}\nfailed() { printf rejected; exit 0; }\n${guard}\nprintf accepted\n`;
    assert.equal((await run(shell, ["-c", script], { timeout: 5000, windowsHide: true })).stdout, version === "25.10" ? "rejected" : "accepted");
  }
  await assert.rejects(fs.stat(f.audit), { code: "ENOENT" });
});

test("swap service binds client/plan/target/pin, preserves only public results and clears IPC credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-preparation-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-preparation-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts/prepare-build-memory.sh"), path.join(root, "infra/scripts/prepare-build-memory.sh"));
  const clientId = randomUUID(), planId = randomUUID(), target = { host: "127.0.0.1", port: 22823, username: "root", fingerprint: "SHA256:" + "A".repeat(43), basePath: "/srv/lms-core/clients" };
  let connections = 0, fail = false;
  const service = new ServerPreparationService(root, { withSession: async (_target, auth, operation) => { connections++; assert.equal(auth.password, "fixture-only"); return operation({ execute: async (command, script) => { assert.equal(command, "sh -s"); assert.ok(!script.includes("fixture-only")); return JSON.stringify(fail ? { version: 1, ok: false, code: "SWAP_ACTIVATION_FAILED" } : { version: 1, ok: true, created: 1, reused: 0, memoryBytes: 1007828992, swapBytes: 4 * 1024 ** 3 }); } }); } }, { get: async () => ({ id: planId, target }) });
  const rejected = { mode: "password", password: "fixture-only" };
  await assert.rejects(service.prepareMemory(clientId, randomUUID(), target, rejected)); assert.equal(connections, 0); assert.equal(rejected.password, undefined);
  const auth = { mode: "password", password: "fixture-only" };
  assert.equal((await service.prepareMemory(clientId, planId, target, auth)).created, true); assert.equal(auth.password, undefined);
  const saved = await fs.readFile(path.join(root, "infra/runtime/memory-preparations", clientId + ".json"), "utf8"); assert.ok(!saved.includes("fixture-only"));
  fail = true; assert.match((await service.prepareMemory(clientId, planId, target, { mode: "password", password: "fixture-only" })).message, /не разрешил включить swap/);
});

for (const rejection of ["INSUFFICIENT_RESOURCES", "UNSUPPORTED_SERVER"]) test(`${rejection} is retryable only after the pinned server confirms that exact pre-change failure`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-preparation-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-preparation-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "infra/scripts"), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, "../../../infra/scripts/prepare-clean-server.sh"), path.join(root, "infra/scripts/prepare-clean-server.sh"));
  const clientId = randomUUID(), planId = randomUUID(), oldId = randomUUID(), target = { host: "127.0.0.1", port: 22823, username: "root", fingerprint: "SHA256:" + "A".repeat(43), basePath: "/srv/lms-core/clients" };
  const directory = path.join(root, "infra/runtime/server-preparations"); await fs.mkdir(directory, { recursive: true });
  const old = { id: oldId, clientId, target, phase: "needs_attention", errorCode: rejection, updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(directory, clientId + ".json"), JSON.stringify(old));
  let connections = 0;
  const service = new ServerPreparationService(root, { withSession: async (_target, auth, operation) => { connections++; assert.equal(auth.password, "fixture-only"); try { return await operation({ execute: async (command) => {
    if (command.startsWith("cat ")) { const id = command.match(/preparations\/([a-f0-9-]+)\/status/)[1]; return JSON.stringify({ id, phase: id === oldId ? "needs_attention" : "succeeded", errorCode: id === oldId ? rejection : "", updatedAt: new Date().toISOString() }); }
    return connections === 2 && command === "sh -s" ? "CORE_UBUNTU_READY" : "";
  } }); } finally { delete auth.password; } } }, { get: async () => ({ id: planId, target }) });
  service.nodeArchive = async () => Buffer.from("fixture archive");
  assert.match((await service.get(clientId)).message, rejection === "INSUFFICIENT_RESOURCES" ? /Не хватает RAM/ : /26\.04/);
  const auth = { mode: "password", password: "fixture-only" };
  assert.equal((await service.prepare(clientId, planId, target, auth, () => {})).phase, "succeeded"); assert.equal(connections, 2); assert.equal(auth.password, undefined);
  await fs.writeFile(path.join(directory, clientId + ".json"), JSON.stringify({ ...old, errorCode: "PREPARATION_INTERRUPTED" }));
  await assert.rejects(service.prepare(clientId, planId, target, { mode: "password", password: "fixture-only" }, () => {}), /предыдущей подготовки/); assert.equal(connections, 2);
});

test("server preparation refuses external or mismatched SSH plans before download or connection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-preparation-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-preparation-")); await fs.rm(root, { recursive: true, force: true }); });
  const id = randomUUID(), planId = randomUUID(); let connections = 0;
  const target = { host: "real.invalid", port: 22, username: "root", fingerprint: "SHA256:" + "A".repeat(43), basePath: "/srv/lms-core/clients" };
  const service = new ServerPreparationService(root, { withSession: async () => { connections++; } }, { get: async () => ({ id: planId, target }) });
  const auth = { mode: "password", password: "fixture-only" };
  await assert.rejects(service.prepare(id, planId, target, auth, () => {})); assert.equal(auth.password, undefined);
  await assert.rejects(service.prepare(id, randomUUID(), { ...target, host: "127.0.0.1" }, { mode: "password" }, () => {}));
  assert.equal(connections, 0);
});

test("local peer input never accepts an administrator password or an arbitrary socket", async () => {
  const input = { databaseMode: "local_peer", databasePassword: "A".repeat(43), clientAdminLogin: "fixture.admin", clientAdminName: "Fixture", clientAdminPassword: "fixture-password-admin", systemAdminLogin: "fixture.system", systemAdminPassword: "fixture-password-system" };
  assert.equal(validateSecrets(input).databaseMode, "local_peer");
  for (const extra of [{ maintenanceUrl: "postgresql://postgres@localhost/postgres" }, { socket: "/tmp/other" }, { password: "do-not-accept" }]) assert.throws(() => validateSecrets({ ...input, ...extra }));
  if (process.platform !== "linux") await assert.rejects(runRuntimeProvisioning({ localPeer: true, clientId: randomUUID(), jobId: randomUUID(), password: "A".repeat(43) }), (error) => error.code === "DATABASE_LOCAL_PEER_REQUIRED");
});

test("clean server script pins Node hash and never resets an existing database password or edits SSH/firewall", async () => {
  const script = await fs.readFile(path.resolve(__dirname, "../../../infra/scripts/prepare-clean-server.sh"), "utf8");
  assert.ok(script.includes("1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce"));
  assert.ok(script.includes("NODE_VERSION_CONFLICT") && script.includes("NODE_PATH_OCCUPIED"));
  assert.ok(script.includes('if [ "$pg_existing" = 0 ]; then systemctl enable --now postgresql'));
  assert.ok(!/ALTER\s+(?:ROLE|USER).*PASSWORD|chpasswd|ufw|iptables|sshd_config|apt-get\s+(?:dist-)?upgrade/i.test(script));
});

test("preparation recovers interrupted state and detects a stopped worker instead of showing endless progress", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-preparation-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-preparation-")); await fs.rm(root, { recursive: true, force: true }); });
  const clientId = randomUUID(), id = randomUUID();
  const target = { host: "127.0.0.1", port: 22823, username: "root", fingerprint: "SHA256:" + "A".repeat(43), basePath: "/srv/lms-core/clients" };
  const directory = path.join(root, "infra/runtime/server-preparations"); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, clientId + ".json"), JSON.stringify({ id, clientId, target, phase: "packages", updatedAt: new Date().toISOString() }));
  const service = new ServerPreparationService(root, { withSession: async (_target, _auth, operation) => operation({ execute: async (command) => command.startsWith("cat ") ? JSON.stringify({ id, phase: "packages", updatedAt: new Date().toISOString() }) : "stopped" }) }, {});
  assert.equal((await service.get(clientId)).phase, "disconnected");
  const auth = { mode: "password", password: "fixture-only" };
  const result = await service.refresh(clientId, target, auth, () => { throw Error("UI closed"); });
  assert.equal(result.phase, "needs_attention"); assert.equal(result.errorCode, "PREPARATION_WORKER_STOPPED"); assert.equal(auth.password, undefined);
  assert.equal((await service.get(clientId)).phase, "needs_attention");
});

test("failed SSH before remote launch can be retried without discarding a running job", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-preparation-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-preparation-")); await fs.rm(root, { recursive: true, force: true }); });
  const clientId = randomUUID(), planId = randomUUID(); let attempts = 0;
  const target = { host: "127.0.0.1", port: 22823, username: "root", fingerprint: "SHA256:" + "A".repeat(43), basePath: "/srv/lms-core/clients" };
  const service = new ServerPreparationService(root, { withSession: async () => { attempts++; throw Error("fixture connection failed"); } }, { get: async () => ({ id: planId, target }) });
  service.nodeArchive = async () => Buffer.from("owned test archive");
  for (let i = 0; i < 2; i++) assert.equal((await service.prepare(clientId, planId, target, { mode: "password" }, () => {})).phase, "failed");
  assert.equal(attempts, 2);
});
