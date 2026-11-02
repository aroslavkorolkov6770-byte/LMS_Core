"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { buildRuntimeBackend } = require("./build-runtime-backend.cjs");
const root = path.resolve(__dirname, "../..");
const run = promisify(execFile);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const runtimeNames = ["app", "public", "next.config.ts", "proxy.ts", "tsconfig.json", "package.json", "package-lock.json"];

async function runtimeFiles(directory) {
  const files = new Map();
  const walk = async (absolute) => {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw Error("SOURCE_SYMLINK");
    if (stat.isDirectory()) for (const name of await fs.readdir(absolute)) await walk(path.join(absolute, name));
    else if (stat.isFile()) files.set(path.relative(directory, absolute).split(path.sep).join("/"), hash(await fs.readFile(absolute)));
    else throw Error("INVALID_SOURCE_FILE");
  };
  for (const name of runtimeNames) await walk(path.join(directory, name));
  return files;
}

async function buildInstallationPackage(sourceId, designId, contentMode = "empty") {
  if (!["empty", "source"].includes(contentMode)) throw Error("INVALID_CONTENT_MODE");
  if (!UUID.test(sourceId)) throw Error("INVALID_SOURCE_ID");
  const directory = path.join(root, "infra/runtime/runtime-adapted-sources", sourceId);
  const source = path.join(directory, "source");
  const adapted = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  if (adapted.id !== sourceId || adapted.sourcePath !== source || adapted.adapterVersion !== 3 || adapted.contentMode !== "empty" || adapted.protocol !== "lms-core-runtime-v1") throw Error("UNSUPPORTED_ADAPTED_SOURCE");
  const receipt = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/local-acceptance", sourceId, "acceptance.json"), "utf8"));
  const adaptationSha256 = hash(Buffer.from(JSON.stringify({ revision: adapted.revision, modifiedFiles: adapted.modifiedFiles, createdFiles: adapted.createdFiles, contentMode: adapted.contentMode })));
  if (receipt.sourceId !== sourceId || receipt.revision !== adapted.revision || receipt.adaptationSha256 !== adaptationSha256 || receipt.contentMode !== "empty" || receipt.productionBuild !== true || receipt.localEndToEnd !== true || receipt.restrictedDatabaseRole !== true) throw Error("LOCAL_LMS_ACCEPTANCE_REQUIRED");
  for (const file of adapted.modifiedFiles) if (hash(await fs.readFile(path.join(source, file.path))) !== file.afterSha256) throw Error("ADAPTED_SOURCE_CHANGED");
  for (const file of adapted.createdFiles) if (hash(await fs.readFile(path.join(source, file.path))) !== file.sha256) throw Error("ADAPTED_SOURCE_CHANGED");
  const backend = await buildRuntimeBackend();
  const id = crypto.randomUUID(), base = path.join(root, "infra/runtime/installation-packages");
  const temporary = path.join(base, `.staging-${id}`), final = path.join(base, id), payload = path.join(temporary, "payload");
  await fs.mkdir(path.join(payload, "lms"), { recursive: true });
  try {
    const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
    const { SourceSnapshotService } = require(path.join(root, "apps/control-center/dist/source-snapshots.js"));
    const { DeploymentPackageService } = require(path.join(root, "apps/control-center/dist/deployment-package.js"));
    const snapshots = new SourceSnapshotService(root, { withReadAccess: async () => { throw Error("Network access is not part of package verification"); } }, tar);
    const snapshot = await snapshots.verifySnapshot(adapted.snapshotId);
    const original = await new DeploymentPackageService(root, snapshots, process.env.CORE_GIT_PATH || (process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "git"), tar).prepare(adapted.snapshotId);
    if (original.revision !== adapted.revision) throw Error("SOURCE_COMMIT_CHANGED");
    const originalDirectory = path.join(temporary, "original");
    await fs.mkdir(originalDirectory);
    await run(tar, ["-xf", original.archivePath, "-C", originalDirectory], { windowsHide: true, timeout: 30000 });
    const before = await runtimeFiles(originalDirectory), after = await runtimeFiles(source);
    const changes = new Map(adapted.modifiedFiles.map((file) => [file.path, file]));
    const additions = new Map(adapted.createdFiles.map((file) => [file.path, file]));
    if (after.size !== before.size + additions.size) throw Error("SOURCE_FILE_SET_CHANGED");
    for (const [name, checksum] of before) {
      const patch = changes.get(name);
      if (patch && patch.beforeSha256 !== checksum || after.get(name) !== (patch?.afterSha256 || checksum)) throw Error("SOURCE_FILE_CHANGED_WITHOUT_ADAPTER");
    }
    for (const [name, addition] of additions) if (before.has(name) || after.get(name) !== addition.sha256) throw Error("SOURCE_ADDITION_CHANGED");
    // Select runtime sources explicitly. Never copy Windows node_modules/.next or pilot data/docs.
    for (const name of runtimeNames) {
      await fs.cp(path.join(source, name), path.join(payload, "lms", name), { recursive: true, errorOnExist: true, force: false });
    }
    await require(path.join(root, "apps/control-center/dist/support-contact-adapter.js")).applySupportPatch(root, path.join(payload, "lms"));
    let design;
    if (designId !== undefined) {
      if (!UUID.test(designId)) throw Error("INVALID_DESIGN_ID");
      const directory = path.join(root, "infra/runtime/client-designs", designId);
      const reference = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
      const contract = require("./client-design-contract.cjs");
      if ((await fs.stat(path.join(directory, "design.json"))).size > contract.MAX_BYTES) throw Error("CLIENT_DESIGN_TOO_LARGE");
      const document = contract.validateClientDesign(JSON.parse(await fs.readFile(path.join(directory, "design.json"), "utf8")));
      if (reference.id !== designId || reference.clientId !== document.clientId || reference.sha256 !== contract.designHash(document)) throw Error("CLIENT_DESIGN_CHANGED");
      if (document.assets?.length) {
        const destination = path.join(payload, "lms/public/core-branding");
        await fs.mkdir(destination);
        for (const asset of document.assets) {
          const file = path.join(directory, "assets", path.basename(asset.path));
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes) throw Error("CLIENT_DESIGN_ASSET_CHANGED");
          const bytes = await fs.readFile(file), image = require("./client-brand-assets.cjs").inspectImage(bytes);
          if (image.sha256 !== asset.sha256 || image.mime !== asset.mime) throw Error("CLIENT_DESIGN_ASSET_CHANGED");
          await fs.writeFile(path.join(destination, path.basename(asset.path)), bytes, { flag: "wx" });
        }
      }
      const presentation = document.version === 3
        ? await require("./lms-point-presentation.cjs").applyPointPresentation(path.join(payload, "lms"), document, adapted.revision)
        : await require("./lms-presentation-adapter.cjs").applyPresentation(path.join(payload, "lms"), document);
      design = { ...presentation, id: designId, assetCount: document.assets?.length || 0 };
      // Next traces the validator's static require even for a legacy v1/v2 document.
      await fs.copyFile(path.join(root, "infra/scripts/point-design-contract.cjs"), path.join(payload, "lms/point-design-contract.cjs"));
    }
    await fs.cp(backend.directory, path.join(payload, "backend"), { recursive: true, errorOnExist: true, force: false });
    await fs.mkdir(path.join(payload, "installer"));
    for (const name of ["runtime-process.cjs", "lms-new-install-worker.cjs", "lms-install-job.cjs"]) await fs.copyFile(path.join(root, "infra/scripts", name), path.join(payload, "installer", name));
    await fs.copyFile(path.join(root, "infra/scripts/source-curriculum.cjs"), path.join(payload, "installer/source-curriculum.cjs"));
    let curriculum;
    if (contentMode === "source") {
      const content = require("./source-curriculum.cjs");
      const bundle = await content.readGitCurriculum(path.join(path.dirname(snapshot.archivePath), "objects.git"), snapshot.revision,
        process.env.CORE_GIT_PATH || (process.platform === "win32" ? "C:/Program Files/Git/cmd/git.exe" : "git"), require(path.join(root, "apps/control-center/node_modules/typescript")));
      curriculum = content.curriculumSummary(bundle);
      await fs.writeFile(path.join(payload, "installer/source-curriculum.json"), JSON.stringify(bundle), { flag: "wx" });
    }
    if (design) await fs.copyFile(path.join(root, "infra/scripts/client-design-contract.cjs"), path.join(payload, "installer/client-design-contract.cjs"));
    if (design) await fs.copyFile(path.join(root, "infra/scripts/point-design-contract.cjs"), path.join(payload, "installer/point-design-contract.cjs"));
    const files = [];
    const walk = async (current) => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw Error("SYMLINK_IN_INSTALLATION_PACKAGE");
        if (entry.isDirectory()) await walk(absolute);
        else {
          if (!entry.isFile()) throw Error("INVALID_INSTALLATION_FILE");
          const bytes = await fs.readFile(absolute);
          files.push({ path: path.relative(payload, absolute).split(path.sep).join("/"), bytes: bytes.length, sha256: hash(bytes) });
        }
      }
    };
    await walk(payload);
    const manifest = { format: "lms-core-install-v1", id, sourceId, revision: adapted.revision, protocol: adapted.protocol,
      baseline: backend.baseline, backendId: backend.id, contentMode, ...(curriculum ? { curriculum } : {}), containsLms: true, containsBackend: true, targetBuildRequired: true, deployed: false,
      ...(design ? { design } : {}),
      files: files.sort((left, right) => left.path.localeCompare(right.path, "en")) };
    await fs.writeFile(path.join(payload, "release-manifest.json"), JSON.stringify(manifest, null, 2));
    await require("./lms-new-install-worker.cjs").verifyPackage(payload, id);
    const archivePath = path.join(temporary, "installation.tar");
    await run(tar, ["-cf", archivePath, "-C", payload, "."], { windowsHide: true, timeout: 60000 });
    const bytes = await fs.readFile(archivePath);
    const result = { id, sourceId, revision: adapted.revision, payloadPath: path.join(final, "payload"), archivePath: path.join(final, "installation.tar"),
      archiveBytes: bytes.length, sha256: hash(bytes), files: files.length, contentMode, ...(curriculum ? { curriculum } : {}), targetBuildRequired: true, deployed: false, ...(design ? { design } : {}) };
    await fs.writeFile(path.join(temporary, "manifest.json"), JSON.stringify(result, null, 2));
    await fs.rename(temporary, final);
    return result;
  } finally {
    if (path.dirname(path.resolve(temporary)) !== path.resolve(base) || path.basename(temporary) !== `.staging-${id}`) throw Error("UNSAFE_INSTALL_PACKAGE_CLEANUP");
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
module.exports = { buildInstallationPackage };
if (require.main === module) void buildInstallationPackage(process.argv[2], process.argv[3] === "-" ? undefined : process.argv[3], process.argv[4] || "empty").then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`Installation package failed: ${error.message}\n`); process.exitCode = 1;
});
