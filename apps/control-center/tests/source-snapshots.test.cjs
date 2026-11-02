const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { SourceSnapshotService, parseSourceTree, sourceWarnings } = require("../dist/source-snapshots.js");
const run = promisify(execFile);
const git = process.platform === "win32" ? "C:/Program Files/Git/cmd/git.exe" : "git";
const tar = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "tar";
const hash = "a".repeat(40);
const config = { url: "git@github.com:fixture/lms.git", branch: "", identityMode: "default", identityFile: "" };
const row = (name, size = 1, mode = "100644") => `${mode} ${mode === "160000" ? "commit" : "blob"} ${hash} ${size}\t${name}\0`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core source test "));
  t.after(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("core source test ")) throw new Error("Unsafe cleanup");
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); }
    catch (error) { console.warn(`Fixture retained: ${root}; ${error.code}`); }
  });
  return root;
}

test("parses NUL-delimited Git file metadata and does not read file contents", () => {
  assert.deepEqual(parseSourceTree(row("app/page.tsx", 25) + row("public/Картинка.svg", 5)), [{ name: "app/page.tsx", bytes: 25 }, { name: "public/Картинка.svg", bytes: 5 }]);
});

test("rejects symlinks, submodules, traversal, device names and case collisions", () => {
  for (const data of [row("link", 5, "120000"), row("module", "-", "160000"), row("../escape"), row("C:/escape"), row(".git/config"), row("app\\page.tsx"), row("NUL.txt"), row("name."), row("x") + row("X")]) {
    assert.throws(() => parseSourceTree(data));
  }
  assert.throws(() => parseSourceTree(""));
  assert.throws(() => parseSourceTree(row("large", 513 * 1024 * 1024)), /512 MiB/);
});

test("flags env, private-key-shaped files and tenant data without reading their contents", () => {
  assert.equal(sourceWarnings([{ name: ".env.example" }, { name: "data/seed/lessons.json" }]).length, 0);
  assert.equal(sourceWarnings([{ name: ".env.local" }, { name: "private.pem" }, { name: "data/users.json" }]).length, 3);
});

async function upstreamFixture(t) {
  const root = await fixture(t);
  const upstream = path.join(root, "upstream");
  const template = path.join(root, "empty-template");
  await fs.mkdir(template);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = path.join(root, "empty-git.config");
  env.GIT_ALLOW_PROTOCOL = "file";
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, "");
  const command = (args, cwd = root) => run(git, ["-c", `core.hooksPath=${template}`, "-c", "commit.gpgsign=false", ...args], { cwd, env, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  await command(["init", "--initial-branch=main", `--template=${template}`, upstream]);
  await fs.writeFile(path.join(upstream, "package.json"), JSON.stringify({ dependencies: { next: "fixture" }, scripts: { build: "never-executed", start: "never-executed" } }));
  await fs.writeFile(path.join(upstream, "package-lock.json"), "{}");
  await fs.writeFile(path.join(upstream, "kept.txt"), "must be in the archive\n");
  await fs.writeFile(path.join(upstream, ".gitattributes"), "kept.txt export-ignore\n");
  await fs.writeFile(path.join(upstream, "script.sh"), "#!/bin/sh\nexit 0\n");
  await command(["add", "--all"], upstream);
  await command(["update-index", "--chmod=+x", "script.sh"], upstream);
  // Commits exist only in this disposable fixture, never in the user's Core repository.
  await command(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], upstream);
  const revision = (await command(["rev-parse", "HEAD"], upstream)).stdout.trim();
  const repository = {
    withReadAccess: async (input, operation) => operation(input, async (args, timeout = 25000, maxBuffer = 16 * 1024 * 1024) => {
      if (args[0] === "ls-remote") return { stdout: `ref: refs/heads/main\tHEAD\n${revision}\tHEAD\n${revision}\trefs/heads/main\n`, stderr: "" };
      const rewritten = args.map((arg) => arg === config.url ? upstream : arg);
      return run(git, rewritten, { cwd: path.join(root, "infra", "runtime"), env, timeout, maxBuffer, windowsHide: true });
    })
  };
  return { root, upstream, revision, repository };
}

test("real Git/tar fixture produces a full immutable source snapshot, without executing project scripts", async (t) => {
  const f = await upstreamFixture(t);
  const service = new SourceSnapshotService(f.root, f.repository, tar);
  const stages = [];
  const result = await service.fetch(config, (state) => stages.push(state.step));
  assert.equal(result.phase, "ready", result.message);
  assert.equal(result.snapshot.revision, f.revision);
  assert.equal(result.snapshot.branch, "main");
  assert.equal(result.snapshot.project.kind, "nextjs");
  assert.equal(result.snapshot.project.packageManager, "npm");
  assert.equal(await fs.readFile(path.join(result.snapshot.sourcePath, "kept.txt"), "utf8"), "must be in the archive\n");
  const listing = (await run(tar, ["-t", "-v", "-f", result.snapshot.archivePath], { windowsHide: true })).stdout;
  assert.match(listing, /kept\.txt/);
  assert.match(listing, /-rwxr-xr-x.*script\.sh/);
  assert.ok(stages.includes("fetching") && stages.includes("packing"));
  assert.equal((await service.verifySnapshot(result.snapshot.id)).archiveSha256, result.snapshot.archiveSha256);
  assert.equal((await service.getState()).phase, "ready");
  assert.equal((await fs.readdir(path.join(f.root, "infra", "runtime", "source-cache"))).some((name) => name.startsWith(".staging-")), false);
  assert.equal(await fs.readFile(path.join(f.upstream, "kept.txt"), "utf8"), "must be in the archive\n");
  await fs.appendFile(result.snapshot.archivePath, "tampered");
  await assert.rejects(service.verifySnapshot(result.snapshot.id), /Архив кода изменен/);
});

test("branch movement during fetch is rejected instead of silently deploying another commit", async (t) => {
  const root = await fixture(t);
  const repository = { withReadAccess: async (input, operation) => operation(input, async (args) => {
    if (args[0] === "ls-remote") return { stdout: `ref: refs/heads/main\tHEAD\n${hash}\trefs/heads/main\n`, stderr: "" };
    if (args.includes("rev-parse")) return { stdout: "b".repeat(40), stderr: "" };
    return { stdout: "", stderr: "" };
  }) };
  const service = new SourceSnapshotService(root, repository, tar);
  const result = await service.fetch(config);
  assert.equal(result.phase, "failed");
  assert.match(result.message, /Ветка изменилась/);
  assert.equal(result.snapshot, null);
  assert.deepEqual(await fs.readdir(path.join(root, "infra", "runtime", "source-cache")), []);
});

test("network/auth errors are sanitized, while the prior snapshot remains only historical", async (t) => {
  const f = await upstreamFixture(t);
  const first = await new SourceSnapshotService(f.root, f.repository, tar).fetch(config);
  assert.equal(first.phase, "ready");
  const failing = { withReadAccess: async () => { throw { stderr: "Permission denied (publickey) fixture-secret" }; } };
  const service = new SourceSnapshotService(f.root, failing, tar);
  const result = await service.fetch({ ...config, url: "git@github.com:other/project.git" });
  assert.equal(result.phase, "failed");
  assert.equal(result.snapshot.id, first.snapshot.id);
  assert.equal(result.repositoryUrl, "git@github.com:other/project.git");
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});

test("aborted saved work and malformed snapshot paths cannot be treated as ready", async (t) => {
  const root = await fixture(t);
  const runtime = path.join(root, "infra", "runtime");
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(runtime, "source-fetch.json"), JSON.stringify({ phase: "working", step: "fetching", message: "old", repositoryUrl: config.url, requestedBranch: "", snapshot: null }));
  const service = new SourceSnapshotService(root, { withReadAccess: async () => { throw new Error("not used"); } }, tar);
  assert.equal((await service.getState()).phase, "failed");
  await assert.rejects(service.verifySnapshot("../../escape"), /Некорректный/);
});

test("a duplicate fetch cannot start while another source operation is active", async (t) => {
  const root = await fixture(t);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const repository = { withReadAccess: async () => { entered(); await wait; throw { killed: true }; } };
  const service = new SourceSnapshotService(root, repository, tar);
  const first = service.fetch(config);
  await started;
  await assert.rejects(service.fetch(config), /уже выполняется/);
  release();
  assert.equal((await first).phase, "failed");
});
