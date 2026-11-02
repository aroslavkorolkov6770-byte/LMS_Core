const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { RepositoryService, normalizeRepositoryConfig, parseRemoteRefs, repositoryFailure } = require("../dist/repository.js");

const config = { url: "git@github.com:example/lms.git", branch: "", identityMode: "default", identityFile: "" };
const revision = "a".repeat(40);
const refs = `ref: refs/heads/main\tHEAD\n${revision}\tHEAD\n${revision}\trefs/heads/main\n${"b".repeat(40)}\trefs/heads/feature/test\n`;
const noProtector = { available: () => false, encrypt: () => { throw new Error("No storage"); }, decrypt: () => "" };
const tools = { git: "core-git.exe", ssh: "C:/Program Files/OpenSSH/ssh.exe", keygen: "core-keygen.exe" };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lms-core-repo-test "));
  t.after(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("lms-core-repo-test ")) {
      throw new Error("Unsafe test cleanup path");
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}

test("normalizes supported SSH URLs and branches", () => {
  assert.deepEqual(normalizeRepositoryConfig({ ...config, url: ` ${config.url} ` }), config);
  assert.equal(normalizeRepositoryConfig({ ...config, url: "ssh://git@example.org:2222/team/lms.git", branch: "feature/test" }).branch, "feature/test");
});

test("rejects non-SSH URLs, passwords, shell syntax and path traversal", () => {
  for (const url of ["https://github.com/x/y", "file:///repo", "ext::sh -c x", "-oProxyCommand=cmd", "git@github.com:x/y;id", "git@github.com:x/../y", "ssh://git:secret@github.com/x/y", "ssh://git@github.com/x/../y", "git@github.com:x/y\ncommand", "ssh://git@github.com/x/%2e%2e/y", "git@github.com:/x/y", "git@github.com:x/y?x=1"]) {
    assert.throws(() => normalizeRepositoryConfig({ ...config, url }), undefined, url);
  }
});

test("rejects invalid refs and public or relative identity files", () => {
  for (const branch of ["-main", "../main", "a..b", "a@{1}", "a.lock", "a/.hidden", "a b", "a*", "a\\b"]) {
    assert.throws(() => normalizeRepositoryConfig({ ...config, branch }));
  }
  for (const identityFile of ["relative-key", path.join(os.tmpdir(), "identity.pub"), 'C:/key"bad']) {
    assert.throws(() => normalizeRepositoryConfig({ ...config, identityMode: "file", identityFile }));
  }
});

test("explains a public key accidentally pasted instead of the repository URL", () => {
  assert.throws(() => normalizeRepositoryConfig({ ...config, url: "ssh-ed25519 AAAA fixture" }), /а не SSH-ключ/);
  assert.throws(() => normalizeRepositoryConfig({ ...config, url: "SHA256:fixture" }), /GitHub Deploy keys/);
});

test("uses actual default or explicitly selected refs, never a fabricated hash", () => {
  const result = parseRemoteRefs(refs, "");
  assert.equal(result.status, "connected");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.selectedBranch, "main");
  assert.equal(result.revision, revision);
  assert.equal(parseRemoteRefs(refs, "feature/test").revision, "b".repeat(40));
  assert.equal(parseRemoteRefs(refs, "missing").status, "branch_missing");
  assert.equal(parseRemoteRefs(`${revision}\trefs/heads/main\n`, "").status, "branch_required");
  assert.equal(parseRemoteRefs("", "").status, "empty_repository");
  assert.equal(parseRemoteRefs("unexpected output", "").canRead, false);
});

test("sanitizes authentication, changed host key, timeout and missing tools", () => {
  assert.equal(repositoryFailure({ stderr: "Permission denied (publickey) secret-token" }).status, "auth_error");
  assert.equal(repositoryFailure({ stderr: "REMOTE HOST IDENTIFICATION HAS CHANGED" }).status, "host_changed");
  assert.equal(repositoryFailure({ stderr: "Host key verification failed" }).status, "host_untrusted");
  assert.equal(repositoryFailure({ killed: true }).status, "network_error");
  assert.equal(repositoryFailure({ code: "ENOENT" }).status, "tool_missing");
  assert.ok(!JSON.stringify(repositoryFailure({ message: "private-token" })).includes("private-token"));
});

test("reads only ls-remote using strict isolated SSH config, then saves the result", async (t) => {
  const root = await fixture(t);
  let calls = 0;
  const service = new RepositoryService(root, tools, noProtector, async (file, args, options) => {
    calls++;
    assert.equal(file, tools.git);
    assert.deepEqual(args, ["ls-remote", "--symref", "--exit-code", "--", config.url, "HEAD", "refs/heads/*"]);
    assert.equal(options.timeout, 25000);
    assert.equal(options.windowsHide, true);
    assert.equal(options.cwd, path.join(root, "infra", "runtime"));
    assert.equal(options.env.GIT_ALLOW_PROTOCOL, "ssh");
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
    const relative = /-F (ssh\/check-[\w-]+\.conf)$/.exec(options.env.GIT_SSH_COMMAND)?.[1];
    assert.ok(relative);
    const settings = await fs.readFile(path.join(options.cwd, relative), "utf8");
    assert.match(settings, /StrictHostKeyChecking yes/);
    assert.match(settings, /UserKnownHostsFile ssh\/known_hosts/);
    assert.match(settings, /GlobalKnownHostsFile none/);
    assert.match(settings, /PasswordAuthentication no/);
    return { stdout: refs, stderr: "" };
  });
  const state = await service.check(config);
  assert.equal(calls, 1);
  assert.equal(state.result.status, "connected");
  assert.ok(Date.parse(state.result.checkedAt));
  assert.deepEqual((await service.getState()).result, state.result);
  assert.equal((await fs.readdir(path.join(root, "infra", "runtime", "ssh"))).some((name) => name.startsWith("check-")), false);
});

test("bad settings do not start Git or write a connection file", async (t) => {
  const root = await fixture(t);
  const service = new RepositoryService(root, tools, noProtector, async () => { assert.fail("No process should start"); });
  await assert.rejects(service.check({ ...config, url: "https://github.com/example/lms" }));
  assert.equal((await service.getState()).result, null);
});

test("repository and branch can be replaced without retaining old connection proof", async (t) => {
  const root = await fixture(t);
  const service = new RepositoryService(root, tools, noProtector, async (_file, args) => {
    if (args.includes("git@github.com:another/project.git")) throw { stderr: "Permission denied (publickey)" };
    return { stdout: refs, stderr: "" };
  });
  assert.equal((await service.check(config)).result.status, "connected");
  const changed = { ...config, url: "git@github.com:another/project.git", branch: "release/new" };
  assert.equal((await service.check(changed)).result.status, "auth_error");
  const saved = await service.getState();
  assert.deepEqual(saved.config, changed);
  assert.equal(saved.result.canRead, false);
  assert.equal(saved.result.revision, null);
  assert.deepEqual(saved.result.branches, []);
});

test("persists a sanitized failed check and handles absent or damaged state", async (t) => {
  const root = await fixture(t);
  const service = new RepositoryService(root, tools, noProtector, async () => {
    throw Object.assign(new Error("private-token"), { stderr: "Permission denied (publickey) private-token" });
  });
  assert.equal((await service.getState()).result, null);
  assert.equal((await service.check(config)).result.status, "auth_error");
  const statePath = path.join(root, "infra", "runtime", "repository-connection.json");
  assert.ok(!(await fs.readFile(statePath, "utf8")).includes("private-token"));
  await fs.writeFile(statePath, JSON.stringify({ config, result: { status: "connected", branches: "not-an-array" } }));
  assert.equal((await service.getState()).result, null);
  await fs.writeFile(statePath, "broken JSON");
  assert.equal((await service.getState()).result, null);
});

test("missing selected branch remains a failed selection even with repository access", async (t) => {
  const root = await fixture(t);
  const service = new RepositoryService(root, tools, noProtector, async () => ({ stdout: refs, stderr: "" }));
  const result = (await service.check({ ...config, branch: "missing" })).result;
  assert.equal(result.status, "branch_missing");
  assert.equal(result.canRead, true);
  assert.equal(result.revision, null);
});

test("external private file is passed to SSH, not read or copied by Core", async (t) => {
  const root = await fixture(t);
  const identityFile = path.join(root, "external key");
  await fs.writeFile(identityFile, "external-private-marker");
  const service = new RepositoryService(root, tools, noProtector, async (_file, _args, options) => {
    const relative = /-F (ssh\/check-[\w-]+\.conf)$/.exec(options.env.GIT_SSH_COMMAND)[1];
    const text = await fs.readFile(path.join(options.cwd, relative), "utf8");
    assert.ok(text.includes(`IdentityFile "${identityFile.replace(/\\/g, "/")}"`));
    assert.match(text, /IdentitiesOnly yes/);
    assert.ok(!text.includes("external-private-marker"));
    return { stdout: refs, stderr: "" };
  });
  assert.equal((await service.check({ ...config, identityMode: "file", identityFile })).result.status, "connected");
  assert.equal(await fs.readFile(identityFile, "utf8"), "external-private-marker");
});

test("concurrent operations are rejected rather than spawning duplicate Git checks", async (t) => {
  const root = await fixture(t);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const service = new RepositoryService(root, tools, noProtector, async () => {
    entered();
    await wait;
    return { stdout: refs, stderr: "" };
  });
  const first = service.check(config);
  await started;
  await assert.rejects(service.check(config), /еще выполняется/);
  release();
  await first;
});

test("refuses plain-text key storage if OS encryption is unavailable", async (t) => {
  const root = await fixture(t);
  const service = new RepositoryService(root, tools, noProtector, async () => { assert.fail("No keygen without OS encryption"); });
  await assert.rejects(service.createManagedKey(), /недоступно/);
  assert.equal((await service.getManagedKey()).available, false);
});

test("managed key lifecycle stores only encrypted private data and cleans temporary identities", async (t) => {
  const root = await fixture(t);
  const plain = "fixture-private-not-a-real-key";
  const encrypted = Buffer.from("encrypted-fixture");
  const publicKey = `ssh-ed25519 ${Buffer.alloc(51, 5).toString("base64")} fixture-public`;
  let generated = 0;
  const protector = {
    available: () => true,
    encrypt: (value) => { assert.equal(value, plain); return encrypted; },
    decrypt: (value) => { assert.deepEqual(value, encrypted); return plain; }
  };
  const service = new RepositoryService(root, tools, protector, async (file, args, options) => {
    if (file === "whoami.exe") return { stdout: '"test","S-1-5-21-100-200-300-400"', stderr: "" };
    if (file === "icacls.exe") return { stdout: "ok", stderr: "" };
    if (file === tools.keygen) {
      generated++;
      const privateFile = args[args.indexOf("-f") + 1];
      await fs.writeFile(privateFile, plain);
      await fs.writeFile(`${privateFile}.pub`, publicKey);
      return { stdout: "", stderr: "" };
    }
    assert.equal(file, tools.git);
    const relative = /-F (ssh\/check-[\w-]+\.conf)$/.exec(options.env.GIT_SSH_COMMAND)[1];
    const text = await fs.readFile(path.join(options.cwd, relative), "utf8");
    const identity = /IdentityFile "(.+)"/.exec(text)[1];
    assert.equal(await fs.readFile(identity, "utf8"), plain);
    throw { stderr: "Permission denied (publickey)", code: 128 };
  });
  const key = await service.createManagedKey();
  assert.equal(key.available, true);
  assert.equal(key.publicKey, publicKey);
  assert.match(key.fingerprint, /^SHA256:/);
  await service.createManagedKey();
  assert.equal(generated, 1);
  const result = await service.check({ ...config, identityMode: "managed" });
  assert.equal(result.result.status, "auth_error");
  const keyDirectory = path.join(root, "infra", "runtime", "ssh", "keys");
  assert.deepEqual((await fs.readdir(keyDirectory)).sort(), ["repository.private.encrypted", "repository.pub"]);
  assert.deepEqual(await fs.readFile(path.join(keyDirectory, "repository.private.encrypted")), encrypted);
  assert.ok(!(await fs.readFile(path.join(root, "infra", "runtime", "repository-connection.json"), "utf8")).includes(plain));
});
