const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { DeploymentPackageService, excludedDeploymentPath } = require("../dist/deployment-package.js");
const git = process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "git";
const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";

test("deployment filter excludes runtime data, secrets, private keys and build artifacts", () => {
  for (const file of ["data/users.json", ".env", ".env.production.local", "uploads/a", "public/uploads/a", "storage/x", "node_modules/x", ".next/a", "infra/runtime/a", "id_ed25519", "secrets/private.pem", "x.p12"]) assert.equal(excludedDeploymentPath(file), true, file);
  for (const file of ["app/page.tsx", "public/logo.svg", "package-lock.json", "data-types.ts"]) assert.equal(excludedDeploymentPath(file), false, file);
});

test("real Git archive omits tenant data/env despite source export rules and preserves code", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-deploy-package-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("core-deploy-package-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const source = path.join(root, "fixture");
  await fs.mkdir(source);
  const files = { "package.json": '{"scripts":{"build":"next build","start":"next start"},"dependencies":{"next":"fixture"}}',
    "package-lock.json": "{}", "app/page.tsx": "export default function Page() { return null; }", "data/users.json": "fixture-private-secret",
    "data/customer file.json": "fixture-private-secret", ".env.production": "SECRET=fixture-private-secret", "public/uploads/a.txt": "fixture-private-secret",
    "public/logo.svg": "<svg/>", ".gitattributes": "app/page.tsx export-ignore\ndata/** -export-ignore\n" };
  for (const [name, value] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true }); await fs.writeFile(path.join(source, name), value); }
  const gitRun = (args, cwd = source) => execFileSync(git, args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  gitRun(["init"]);
  gitRun(["add", "."]);
  // Only disposable test fixtures are committed, never the user's repository.
  gitRun(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  const revision = gitRun(["rev-parse", "HEAD"]).trim();
  const snapshotId = "f0140c68-d136-4fe2-aa40-80d9ae2e5185";
  const directory = path.join(root, "infra/runtime/source-cache", snapshotId);
  await fs.mkdir(directory, { recursive: true });
  gitRun(["clone", "--bare", source, path.join(directory, "objects.git")]);
  const snapshot = { id: snapshotId, revision, archivePath: path.join(directory, "source.tar"), repositoryUrl: "git@github.com:fixture/lms.git", branch: "main",
    project: { kind: "nextjs", packageManager: "npm", hasBuild: true, hasStart: true } };
  const service = new DeploymentPackageService(root, { verifySnapshot: async () => snapshot }, git, tar);
  const result = await service.prepare(snapshotId);
  const listed = execFileSync(tar, ["-tf", result.archivePath], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  assert.ok(listed.includes("app/page.tsx"));
  assert.ok(listed.includes("public/logo.svg"));
  assert.equal(listed.some(excludedDeploymentPath), false);
  assert.equal((await fs.readFile(result.archivePath)).includes(Buffer.from("fixture-private-secret")), false);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.stat(path.join(path.dirname(result.archivePath), "objects.git")), { code: "ENOENT" });
});
