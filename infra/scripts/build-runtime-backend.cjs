const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { createRequire } = require("node:module");
const { promisify } = require("node:util");
const run = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function thirdPartyNotices(inputs) {
  const packages = new Map();
  for (const name of inputs.filter((input) => input.split(path.sep).join("/").includes("node_modules/"))) {
    let directory = path.dirname(path.resolve(name));
    while (directory !== path.dirname(directory)) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
        if (pkg.name && pkg.version) packages.set(`${pkg.name}@${pkg.version}`, { directory, license: typeof pkg.license === "string" ? pkg.license : "Not specified in package metadata" });
        break;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      directory = path.dirname(directory);
    }
  }
  const notices = [];
  for (const [name, pkg] of [...packages].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const files = (await fs.readdir(pkg.directory)).filter((file) => /^(?:licen[sc]e|copying|notice)(?:[._-]|$)/i.test(file)).sort();
    const texts = [];
    for (const file of files) if ((await fs.stat(path.join(pkg.directory, file))).isFile()) texts.push(`${file}\n${await fs.readFile(path.join(pkg.directory, file), "utf8")}`);
    notices.push(`${name}\nLicense metadata: ${pkg.license}\n${texts.join("\n\n")}`);
  }
  return { count: packages.size, text: notices.join("\n\n========================================\n\n") };
}

async function buildRuntimeBackend() {
  const apiRequire = createRequire(path.join(root, "apps/api/package.json"));
  const tsc = apiRequire.resolve("typescript/bin/tsc");
  for (const project of ["packages/db/tsconfig.json", "apps/api/tsconfig.json"]) {
    await run(process.execPath, [tsc, "--project", path.join(root, project)], { cwd: root, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  }
  // Reuse the locked offline development toolchain. It is not part of the runtime archive.
  const kitRequire = createRequire(await fs.realpath(path.join(root, "packages/db/node_modules/drizzle-kit/package.json")));
  const esbuild = kitRequire("esbuild");
  const db = require(path.join(root, "packages/db/dist/src/index.js"));
  const sql = await fs.readFile(path.join(root, "packages/db/install-baseline/0000_core_runtime_v1.sql"), "utf8");
  const spec = JSON.parse(await fs.readFile(path.join(root, "packages/db/install-baseline/baseline-spec.json"), "utf8"));
  if (spec.version !== db.FRESH_SCHEMA_VERSION || spec.sqlFile !== "0000_core_runtime_v1.sql" || spec.sha256 !== db.contentSha256(sql) || spec.schemaSha256 !== db.freshSchemaSha256()) {
    throw new Error("Fresh baseline differs from the pinned SQL/schema specification; regenerate and validate a new schema version before packaging");
  }
  const baseline = { version: spec.version, sha256: spec.sha256, schemaSha256: spec.schemaSha256 };
  const id = randomUUID();
  const base = path.join(root, "infra/runtime/runtime-backend-packages");
  const temporary = path.join(base, `.staging-${id}`);
  const final = path.join(base, id);
  const backend = path.join(temporary, "backend");
  await fs.mkdir(backend, { recursive: true });
  try {
    const result = await esbuild.build({
      entryPoints: { "runtime-api": path.join(root, "apps/api/dist/runtime-main.js"), "runtime-init": path.join(root, "apps/api/dist/runtime-init.js"), "runtime-provision": path.join(root, "apps/api/dist/runtime-provision.js") },
      outdir: backend, outExtension: { ".js": ".cjs" }, bundle: true, platform: "node", target: "node22", format: "cjs",
      sourcemap: false, metafile: true, legalComments: "linked", logLevel: "silent",
      external: ["@nestjs/microservices", "@nestjs/microservices/*", "@nestjs/websockets", "@nestjs/websockets/*", "class-transformer/storage"]
    });
    const apiPrefix = "apps/api/dist/";
    const allowed = ["runtime-main.js", "runtime-app.module.js", "runtime-init.js", "runtime-provision.js", "config/app.config.js"];
    const forbidden = Object.keys(result.metafile.inputs).map((name) => path.relative(root, path.resolve(name)).split(path.sep).join("/"))
      .filter((name) => name.startsWith(apiPrefix)).map((name) => name.slice(apiPrefix.length))
      .filter((name) => !allowed.includes(name) && !name.startsWith("modules/database/") && !name.startsWith("modules/lms-runtime/"));
    if (forbidden.length) throw new Error("Runtime package includes a control-plane module");
    const notices = await thirdPartyNotices(Object.keys(result.metafile.inputs));
    await fs.writeFile(path.join(backend, "THIRD_PARTY_NOTICES.txt"), notices.text);
    await fs.writeFile(path.join(backend, "baseline.sql"), sql);
    await fs.writeFile(path.join(backend, "baseline-manifest.json"), JSON.stringify(baseline, null, 2));
    await fs.writeFile(path.join(backend, "package.json"), JSON.stringify({ name: "lms-core-runtime", version: "1.0.0", private: true,
      engines: { node: ">=22" }, scripts: { start: "node runtime-api.cjs", "init:fresh": "node runtime-init.cjs", "provision:database": "node runtime-provision.cjs" } }, null, 2));
    const files = [];
    for (const name of (await fs.readdir(backend)).sort()) {
      const bytes = await fs.readFile(path.join(backend, name));
      if (bytes.includes(Buffer.from(root)) || bytes.includes(Buffer.from(root.replaceAll("\\", "/")))) throw new Error("Runtime package contains a laptop path");
      files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const release = { format: "lms-core-runtime-backend-v1", id, baseline, nodeMajorMinimum: 22,
      containsBackend: true, containsLms: false, controlPlaneIncluded: false, deployed: false, bundlerVersion: esbuild.version,
      schemaTables: db.freshSchemaShape().length, thirdPartyPackages: notices.count, files };
    await fs.writeFile(path.join(backend, "release-manifest.json"), JSON.stringify(release, null, 2));
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32/tar.exe") : "tar";
    const archive = path.join(temporary, "runtime-backend.tar");
    await run(tar, ["-cf", archive, "-C", backend, "."], { windowsHide: true, timeout: 30000 });
    const value = { ...release, directory: path.join(final, "backend"), archivePath: path.join(final, "runtime-backend.tar"),
      sha256: sha256(await fs.readFile(archive)), archiveBytes: (await fs.stat(archive)).size };
    await fs.writeFile(path.join(temporary, "manifest.json"), JSON.stringify(value, null, 2));
    await fs.rename(temporary, final);
    return value;
  } finally {
    if (path.dirname(path.resolve(temporary)) !== path.resolve(base) || path.basename(temporary) !== `.staging-${id}`) throw new Error("Unsafe runtime package cleanup");
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { buildRuntimeBackend };
if (require.main === module) void buildRuntimeBackend().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  // Build diagnostics contain source/module locations but never an environment or credential value.
  process.stderr.write(`Runtime package build failed: ${error.message}\n`); process.exitCode = 1;
});
