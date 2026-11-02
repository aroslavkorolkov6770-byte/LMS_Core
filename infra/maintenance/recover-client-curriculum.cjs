"use strict";
const path = require("node:path"), fs = require("node:fs/promises");
const { app, safeStorage } = require("electron");
app.setPath("userData", path.join(app.getPath("appData"), "@lms-core/control-center"));
const root = path.resolve(__dirname, "../..");
const { readSourceCurriculum } = require("../scripts/source-curriculum.cjs");
const { RepositoryService } = require(path.join(root, "apps/control-center/dist/repository.js"));
const { SourceSnapshotService } = require(path.join(root, "apps/control-center/dist/source-snapshots.js"));
const { ClientServerStore } = require(path.join(root, "apps/control-center/dist/client-servers.js"));
const { ClientInstallationAccessStore } = require(path.join(root, "apps/control-center/dist/client-installation-access.js"));
const { RemoteTargetService } = require(path.join(root, "apps/control-center/dist/remote-target.js"));
let stage = "validate";
app.whenReady().then(async () => {
  const [clientId, host] = process.argv.slice(2);
  if (!/^[a-f0-9-]{36}$/.test(clientId || "")) throw Error("CURRICULUM_TARGET_INVALID");
  const state = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/new-deployments", clientId + ".json"), "utf8"));
  if (state.clientId !== clientId || state.phase !== "succeeded" || state.target.host !== host || !state.target.fingerprint) throw Error("CURRICULUM_TARGET_CHANGED");
  const protector = { available: () => safeStorage.isEncryptionAvailable(), encrypt: v => safeStorage.encryptString(v), decrypt: v => safeStorage.decryptString(v) };
  const repository = new RepositoryService(root, { git: "C:/Program Files/Git/cmd/git.exe", ssh: "C:/Windows/System32/OpenSSH/ssh.exe", keygen: "C:/Windows/System32/OpenSSH/ssh-keygen.exe" }, protector);
  const sources = new SourceSnapshotService(root, repository, "C:/Windows/System32/tar.exe");
  stage = "verify-source";
  const snapshot = await sources.verifySnapshot(state.snapshotId);
  const expectedRepository = "git@github.com:aroslavkorolkov6770-byte/Kapustin_beta.git";
  if (snapshot.repositoryUrl !== expectedRepository || snapshot.revision !== state.revision) throw Error("CURRICULUM_SOURCE_MISMATCH");
  const remoteRevision = await repository.withReadAccess({ url: expectedRepository, branch: snapshot.branch, identityMode: "managed", identityFile: "" }, async (config, git) => {
    const result = await git(["ls-remote", "--heads", config.url, "refs/heads/" + snapshot.branch]);
    return result.stdout.trim().split(/\s+/)[0];
  });
  if (remoteRevision !== snapshot.revision) throw Error("CURRICULUM_GIT_REVISION_CHANGED");
  const run = require("node:util").promisify(require("node:child_process").execFile);
  const curriculumFiles = ["data/tea_hub_dynamic_route_v2.json", "app/tasks/data/defaultTrainingTests.ts", "data/tea_hub_dynamic_tests_v1.json"];
  const listed = new Set((await run("C:/Program Files/Git/cmd/git.exe", ["--git-dir", path.join(path.dirname(snapshot.archivePath), "objects.git"), "ls-tree", "-r", "--name-only", snapshot.revision, "--", ...curriculumFiles], { windowsHide: true })).stdout.trim().split(/\r?\n/));
  for (const file of curriculumFiles) {
    if (!listed.has(file)) {
      if (file !== "data/tea_hub_dynamic_tests_v1.json") throw Error("CURRICULUM_SOURCE_MISSING");
      try { await fs.lstat(path.join(snapshot.sourcePath, file)); throw Error("CURRICULUM_WORKING_SOURCE_CHANGED"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      continue;
    }
    const original = await run("C:/Program Files/Git/cmd/git.exe", ["--git-dir", path.join(path.dirname(snapshot.archivePath), "objects.git"), "show", `${snapshot.revision}:${file}`], { windowsHide: true, maxBuffer: 6 * 1024 * 1024 });
    if (original.stdout !== await fs.readFile(path.join(snapshot.sourcePath, file), "utf8")) throw Error("CURRICULUM_WORKING_SOURCE_CHANGED");
  }
  const bundle = { ...await readSourceCurriculum(snapshot.sourcePath, require(path.join(root, "apps/control-center/node_modules/typescript"))), revision: snapshot.revision };
  const modules = {};
  for (const name of ["source-curriculum.cjs", "configure-lms-ai.cjs", "runtime-process.cjs"]) modules["./" + name] = await fs.readFile(path.join(root, "infra/scripts", name), "utf8");
  const input = { clientId, jobId: state.id, releaseId: state.releaseId, appPath: state.target.appPath, webPort: state.webPort };
  const apply = process.argv.includes("--apply");
  const script = `const sources=${JSON.stringify(modules)},cache={};function load(name){if(!sources[name])return require(name);if(cache[name])return cache[name].exports;const m={exports:{}};cache[name]=m;new Function('require','module','exports',sources[name])(load,m,m.exports);return m.exports;}load('./source-curriculum.cjs').recoverSourceCurriculum(${JSON.stringify(input)},${JSON.stringify(bundle)},{apply:${apply}}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>process.stdout.write(JSON.stringify({phase:'failed',errorCode:/^[A-Z_]{1,80}$/.test(e.code||e.message||'')?e.code||e.message:'CURRICULUM_RECOVERY_FAILED'})));`;
  const store = new ClientServerStore(path.join(app.getPath("userData"), "client-servers"), protector);
  const access = new ClientInstallationAccessStore(path.join(app.getPath("userData"), "installation-access"), protector);
  const remote = new RemoteTargetService(root, undefined, async (target, auth) => (await store.get(clientId, target)).passwordSaved ? store.credentials(target, auth) : access.sshCredentials(target, auth));
  stage = apply ? "apply" : "inspect";
  const result = JSON.parse(await remote.withSession(state.target, { mode: "password", savedForClient: clientId }, session => session.execute("node -", script, 120000)));
  if (process.argv.includes("--verify-web") && result.phase !== "failed") {
    stage = "verify-web-health";
    const base = `https://${host}`;
    const health = await fetch(base + "/api/core-runtime/health", { redirect: "error", signal: AbortSignal.timeout(15000) });
    const identity = await health.json();
    if (!health.ok || identity.clientId !== clientId || identity.releaseId !== state.releaseId) throw Error("CURRICULUM_WEB_IDENTITY_MISMATCH");
    stage = "verify-web-card";
    const card = await access.get(clientId), canonical = card.values;
    if (!canonical || canonical.host !== host) throw Error("CURRICULUM_CARD_TARGET_CHANGED");
    stage = "verify-web-access";
    const input = await access.resolve(clientId, { useSavedAccess: true, clientAdminLogin: canonical.clientAdminLogin, systemAdminLogin: canonical.systemAdminLogin }, canonical);
    let cookie = "";
    try {
      stage = "verify-web-login";
      const login = await fetch(base + "/api/auth/login", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ login: input.clientAdminLogin, password: input.clientAdminPassword }) });
      if (!login.ok || !(await login.json()).success) throw Error("CURRICULUM_WEB_LOGIN_FAILED");
      stage = "verify-web-cookie";
      cookie = login.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
      if (!cookie) throw Error("CURRICULUM_WEB_SESSION_MISSING");
      stage = "verify-web-storage";
      const response = await fetch(base + "/api/storage?keys=tea_hub_dynamic_route_v2,tea_hub_dynamic_tests_v1", { redirect: "error", signal: AbortSignal.timeout(15000), headers: { Cookie: cookie } });
      const content = await response.json();
      const digest = value => require("node:crypto").createHash("sha256").update(JSON.stringify(value)).digest("hex");
      if (!response.ok || digest(content.tea_hub_dynamic_route_v2) !== digest(bundle.entries[0].data) || digest(content.tea_hub_dynamic_tests_v1) !== digest(bundle.entries[1].data)) throw Error("CURRICULUM_WEB_CONTENT_MISMATCH");
      result.webCheck = { https: true, authenticated: true, storageStatus: response.status, topics: content.tea_hub_dynamic_route_v2.length,
        tests: content.tea_hub_dynamic_tests_v1.length, questions: content.tea_hub_dynamic_tests_v1.reduce((n, v) => n + v.quiz.length, 0), contentMatchesGit: true };
    } finally { input.clientAdminPassword = ""; input.systemAdminPassword = ""; cookie = ""; }
  }
  const folder = path.join(root, "infra/runtime/curriculum-recovery"); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, `${clientId}-${apply ? "applied" : "inspected"}.json`), JSON.stringify({ ...result, repositoryUrl: expectedRepository, snapshotId: snapshot.id }, null, 2));
  console.log(JSON.stringify(result)); app.exit(result.phase === "failed" ? 1 : 0);
}).catch(error => { console.error(JSON.stringify({ stage, errorCode: /^[A-Z_]{1,80}$/.test(error.code || error.message || "") ? error.code || error.message : "CURRICULUM_RECOVERY_FAILED", errorType: ["Error", "TypeError", "TimeoutError", "AbortError"].includes(error.name) ? error.name : "Error" })); app.exit(1); });
