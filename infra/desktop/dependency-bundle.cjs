"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), { createRequire } = require("node:module");

// Copy each locked, installed package once. Junctions are recreated on the recipient's computer,
// so no absolute links to the developer's pnpm store enter the installer.
async function bundleDependencies(root, output, projects) {
  const links = [], packages = [], seen = new Map();
  async function findDependency(directory, name) {
    const resolver = createRequire(path.join(directory, "package.json"));
    const candidates = resolver.resolve.paths(name) || [];
    for (let parent = directory; parent !== path.dirname(parent); parent = path.dirname(parent)) candidates.push(path.join(parent, "node_modules"));
    for (const candidate of candidates) {
      try { return await fs.realpath(path.join(candidate, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    throw Object.assign(Error("DESKTOP_DEPENDENCY_MISSING:" + name), { code: "ENOENT" });
  }
  async function visit(directory, workspace) {
    const real = await fs.realpath(directory);
    if (seen.has(real)) return seen.get(real);
    const pkg = JSON.parse(await fs.readFile(path.join(real, "package.json"), "utf8"));
    const target = workspace || "vendor/npm/" + crypto.createHash("sha256").update(pkg.name + "@" + pkg.version + ":" + path.relative(root, real)).digest("hex").slice(0, 20);
    seen.set(real, target); packages.push({ name: pkg.name, version: pkg.version, directory: target });
    links.push({ from: target + "/node_modules/" + pkg.name, to: target });
    if (!workspace) {
      let exists = false; try { await fs.access(path.join(output, target, "package.json")); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!exists) await fs.cp(real, path.join(output, target), { recursive: true, dereference: true,
        filter: source => !path.relative(real, source).split(path.sep).some(part => ["node_modules", "test", "tests", "__tests__", ".github"].includes(part)) });
    }
    const dependencies = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
    if (workspace) for (const name of ["typescript", "@types/node", "@types/react", "@types/react-dom", "drizzle-kit", "tsx"]) {
      if (pkg.devDependencies?.[name]) dependencies[name] = pkg.devDependencies[name];
    }
    for (const name of Object.keys(dependencies).sort()) {
      let child;
      try { child = await findDependency(real, name); }
      catch (error) { if (error.code === "ENOENT" && (pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional)) continue; throw error; }
      const relative = path.relative(root, child).replaceAll(path.sep, "/");
      const ownProject = projects.includes(relative) ? relative : undefined;
      const destination = await visit(child, ownProject);
      links.push({ from: target + "/node_modules/" + name, to: destination });
    }
    return target;
  }
  for (const project of projects) await visit(path.join(root, project), project);
  return { links, packages };
}

function safeRelative(value) {
  return typeof value === "string" && value.length < 500 && !value.includes("\\") && !value.includes(":") &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}
async function linkDependencies(root, links, update = false) {
  const logicalRoot = root;
  root = await fs.realpath(root);
  for (const link of links) {
    if (!safeRelative(link.from) || !safeRelative(link.to) || !link.from.includes("/node_modules/")) throw Error("DESKTOP_LINK_INVALID");
    const from = path.join(root, link.from), to = path.join(root, link.to);
    await fs.mkdir(path.dirname(from), { recursive: true });
    try {
      const stat = await fs.lstat(from);
      if (!stat.isSymbolicLink()) throw Error("DESKTOP_LINK_OCCUPIED");
      let existing;
      try { existing = path.resolve(await fs.realpath(from)); }
      catch (error) {
        const raw = await fs.readlink(from), relative = path.relative(logicalRoot, raw).replaceAll(path.sep, "/");
        if (error.code !== "ENOENT" || !update || !safeRelative(relative) || !/^(vendor\/npm|packages|apps)\//.test(relative)) throw error;
        await fs.unlink(from); await fs.symlink(to, from, "junction"); continue;
      }
      const rawTarget = path.resolve(await fs.readlink(from));
      if (existing !== path.resolve(to) || update && rawTarget !== path.resolve(to)) {
        const relative = path.relative(root, existing).replaceAll(path.sep, "/");
        if (!update || !safeRelative(relative) || !/^(vendor\/npm|packages|apps)\//.test(relative)) throw Error("DESKTOP_LINK_OCCUPIED");
        await fs.unlink(from); await fs.symlink(to, from, "junction");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.symlink(to, from, "junction");
    }
  }
}
module.exports = { bundleDependencies, linkDependencies, safeRelative };
if (require.main === module) void (async () => {
  const root = path.resolve(process.argv[2]), manifest = JSON.parse(await fs.readFile(path.join(root, "desktop-bundle.json"), "utf8"));
  if (manifest.format !== "lms-core-desktop-v1" || !Array.isArray(manifest.links)) throw Error("DESKTOP_BUNDLE_INVALID");
  await linkDependencies(root, manifest.links, true);
})().catch(() => { process.stderr.write("DESKTOP_DEPENDENCY_LINK_FAILED\n"); process.exitCode = 1; });
