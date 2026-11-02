const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { parseNewServerPreflight } = require("../dist/new-installation.js");
const run = promisify(execFile);
const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "/bin/sh";
const posix = (value) => process.platform === "win32" ? `/${value[0].toLowerCase()}${value.slice(2).replace(/\\/g, "/")}` : value;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-new-preflight-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("core-new-preflight-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const scripts = {
    uname: "printf 'Linux\\n'", id: 'if [ "$1" = "-u" ]; then printf "0\\n"; else printf "root\\n"; fi',
    node: "printf 'v22.fixture\\n'", npm: "printf '12.fixture\\n'", pm2: "exit 99", ss: "printf 'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*\\n'",
    psql: "exit 99", runuser: "printf 'core-db-admin-ok\\n'",
    df: "printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fixture 20000000 1000 19000000 1%% /fixture\\n'"
  };
  for (const [name, body] of Object.entries(scripts)) await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(root, "os-release"), 'PRETTY_NAME="Ubuntu fixture"\n');
  await fs.writeFile(path.join(root, "meminfo"), "MemTotal: 1000000 kB\nSwapTotal: 4000000 kB\n");
  const app = path.join(root, "client-one");
  const template = await fs.readFile(path.resolve(__dirname, "../../../infra/scripts/lms-new-install-preflight.sh"), "utf8");
  const inspect = async (webStart = 3000) => {
    const script = template.replace("export LC_ALL=C", `export LC_ALL=C\nPATH='${posix(bin)}':/usr/bin:/bin\nexport PATH`)
      .replaceAll("__CORE_INSTALL_PATH__", posix(app)).replaceAll("__CORE_WEB_PORT_START__", String(webStart)).replaceAll("/etc/os-release", posix(path.join(root, "os-release"))).replaceAll("/proc/meminfo", posix(path.join(root, "meminfo")));
    const result = await run(shell, ["-c", script], { timeout: 10000, windowsHide: true });
    return parseNewServerPreflight(result.stdout, posix(app));
  };
  return { root, bin, app, inspect };
}

test("real shell fixture reads an unused path and skips the occupied port without creating or starting anything", async (t) => {
  const f = await fixture(t);
  const before = await fs.readdir(f.root);
  const result = await f.inspect();
  assert.equal(result.pathState, "available");
  assert.equal(result.candidatePort, 3001);
  assert.equal(result.node, "v22.fixture");
  assert.equal(result.os, "Ubuntu fixture");
  assert.equal(result.postgresState, "ready");
  assert.deepEqual(await fs.readdir(f.root), before);
  await assert.rejects(fs.stat(f.app), { code: "ENOENT" });
});

test("missing and inaccessible PostgreSQL are distinguished without reading credentials or starting services", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.bin, "runuser"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal((await f.inspect()).postgresState, "unavailable");
  await fs.writeFile(path.join(f.bin, "id"), '#!/bin/sh\nif [ "$1" = postgres ]; then exit 1; elif [ "$1" = -u ]; then printf "0\\n"; else printf "root\\n"; fi\n', { mode: 0o755 });
  assert.equal((await f.inspect()).postgresState, "missing");
  await assert.rejects(fs.stat(f.app), { code: "ENOENT" });
});

test("existing installation is reported as occupied and its files stay unchanged", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.app);
  await fs.writeFile(path.join(f.app, "data.txt"), "fixture-secret-do-not-read");
  const result = await f.inspect();
  assert.equal(result.pathState, "occupied");
  assert.equal(result.writable, false);
  assert.ok(!JSON.stringify(result).includes("fixture-secret-do-not-read"));
  assert.equal(await fs.readFile(path.join(f.app, "data.txt"), "utf8"), "fixture-secret-do-not-read");
});

test("local Linux range leaves the Core ports untouched", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.inspect(3010)).candidatePort, 3010);
});

test("failed socket inspection cannot fabricate a free port", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.bin, "ss"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = await f.inspect();
  assert.equal(result.ssAvailable, false);
  assert.equal(result.candidatePort, null);
});
