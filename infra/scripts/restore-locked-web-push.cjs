// Repair two absent, already-locked packages. No dependency upgrades or package lifecycle scripts.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createRequire } = require("node:module");
const run = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const plans = [
  { name: "https-proxy-agent", version: "7.0.6", dependencies: { "agent-base": "agent-base@7.1.4", debug: "debug@4.4.3_supports-color@8.1.1" } },
  { name: "web-push", version: "3.6.7", dependencies: { "asn1.js": "asn1.js@5.4.1", http_ece: "http_ece@1.2.0", "https-proxy-agent": "https-proxy-agent@7.0.6", jws: "jws@4.0.1", minimist: "minimist@1.2.8" } }
];

(async () => {
  if (process.platform !== "win32") throw new Error("This repair targets the inspected Windows node_modules layout only");
  const lock = await fs.readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
  const receipt = [];
  for (const plan of plans) {
    const directory = path.join(root, "node_modules/.pnpm", `${plan.name}@${plan.version}`, "node_modules");
    const target = path.join(directory, plan.name);
    try { await fs.access(path.join(target, "package.json")); receipt.push({ name: plan.name, version: plan.version, alreadyPresent: true }); continue; } catch {}
    try { if ((await fs.readdir(target)).length) throw new Error("Refusing to overwrite an existing partial package"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const escaped = `${plan.name}@${plan.version}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = lock.match(new RegExp(`^  ${escaped}:\\r?\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`, "m"));
    if (!match) throw new Error("Exact locked integrity was not found");
    const temporary = path.join(root, "infra/runtime/dependency-repair", randomUUID());
    await fs.mkdir(temporary, { recursive: true });
    const response = await fetch(`https://registry.npmjs.org/${plan.name}/-/${plan.name}-${plan.version}.tgz`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Locked package download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) throw new Error("Unexpected package size");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== match[1]) throw new Error("Package archive does not match pnpm-lock.yaml");
    const archive = path.join(temporary, "package.tgz"), extracted = path.join(temporary, "package");
    await fs.writeFile(archive, bytes);
    const options = { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 };
    const listing = (await run("tar.exe", ["-tzf", archive], options)).stdout.trim().split(/\r?\n/);
    if (!listing.length || listing.some((entry) => !entry.startsWith("package/") || entry.includes("\\") || entry.split("/").includes(".."))) throw new Error("Unsafe package archive path");
    const detailed = (await run("tar.exe", ["-tvzf", archive], options)).stdout.trim().split(/\r?\n/);
    if (detailed.some((entry) => !["-", "d"].includes(entry[0]))) throw new Error("Package links/devices are not accepted");
    await fs.mkdir(extracted);
    await run("tar.exe", ["-xzf", archive, "--strip-components", "1", "-C", extracted], options);
    const manifest = JSON.parse(await fs.readFile(path.join(extracted, "package.json"), "utf8"));
    if (manifest.name !== plan.name || manifest.version !== plan.version) throw new Error("Wrong locked package manifest");
    await fs.mkdir(directory, { recursive: true });
    await fs.rename(extracted, target);
    for (const [name, virtual] of Object.entries(plan.dependencies)) {
      const dependency = path.join(root, "node_modules/.pnpm", virtual, "node_modules", name);
      await fs.access(path.join(dependency, "package.json"));
      await fs.symlink(dependency, path.join(directory, name), "junction");
    }
    createRequire(path.join(target, "package.json"))(plan.name);
    receipt.push({ name: plan.name, version: plan.version, archiveBytes: bytes.length, lockIntegrityVerified: true, lifecycleScriptsRun: false });
  }
  createRequire(path.join(root, "apps/lms-web/package.json"))("web-push");
  console.log(JSON.stringify({ restored: receipt, manifestAndLockUnchanged: true }));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
