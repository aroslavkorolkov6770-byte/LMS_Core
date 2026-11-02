const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const assert = require("node:assert/strict");

function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }); }

async function isolatedNext(root, project, output, backendOrigin) {
  const workspace = path.join(output, "workspace"), source = path.join(root, "apps", project), app = path.join(workspace, "apps", project);
  await fs.mkdir(app, { recursive: true });
  const configName = project === "deploy-panel" ? "next.config.js" : "next.config.ts";
  for (const name of ["app", "public", configName, "next-env.d.ts", "package.json", "tsconfig.json"]) {
    try { await fs.cp(path.join(source, name), path.join(app, name), { recursive: true }); } catch (error) { if (name !== "public" || error.code !== "ENOENT") throw error; }
  }
  const configFile = path.join(app, configName), config = await fs.readFile(configFile, "utf8");
  const declaration = configName.endsWith(".ts") ? "const nextConfig: NextConfig = {" : "const nextConfig = {";
  assert.ok(config.includes(declaration));
  await fs.writeFile(configFile, config.replace(declaration, `${declaration}\n  experimental: { cpus: 1 },`));
  await fs.copyFile(path.join(root, "tsconfig.base.json"), path.join(workspace, "tsconfig.base.json"));
  await fs.mkdir(path.join(workspace, "packages/shared"), { recursive: true });
  await fs.cp(path.join(root, "packages/shared/src"), path.join(workspace, "packages/shared/src"), { recursive: true });
  if (project === "deploy-panel") {
    await fs.mkdir(path.join(workspace, "apps/control-center/renderer"), { recursive: true });
    await fs.copyFile(path.join(root, "apps/control-center/renderer/palettes.css"), path.join(workspace, "apps/control-center/renderer/palettes.css"));
  }
  await fs.symlink(path.join(source, "node_modules"), path.join(app, "node_modules"), "junction");
  const reserve = http.createServer(); const port = await listen(reserve); await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=3072", DEPLOY_PANEL_API_URL: backendOrigin };
  const cli = path.join(source, "node_modules/next/dist/bin/next");
  let server, build;
  async function cleanup() {
    for (const child of [server, build]) {
      if (child && child.exitCode === null) { const stopped = once(child, "exit").catch(() => {}); child.kill(); await stopped; }
    }
    const resolved = await fs.realpath(workspace);
    if (resolved.toLowerCase() !== path.resolve(output, "workspace").toLowerCase() || !resolved.toLowerCase().startsWith(`${path.resolve(root, "infra/runtime/local-acceptance").toLowerCase()}${path.sep}`)) throw new Error("Refusing isolated build cleanup outside acceptance root");
    const link = path.join(app, "node_modules");
    if (!(await fs.lstat(link)).isSymbolicLink()) throw new Error("Unexpected isolated dependency directory");
    await fs.unlink(link);
    await fs.rm(resolved, { recursive: true, force: true });
  }
  try {
    const started = Date.now();
    let buildLog = "";
    build = spawn(process.execPath, [cli, "build", app], { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    build.stdout.on("data", (chunk) => { buildLog += chunk; }); build.stderr.on("data", (chunk) => { buildLog += chunk; });
    const buildDeadline = setTimeout(() => build.kill(), 180000);
    let exitCode;
    try { [exitCode] = await once(build, "exit"); } finally { clearTimeout(buildDeadline); }
    await fs.writeFile(path.join(output, "build.log"), buildLog);
    if (exitCode !== 0) throw new Error(`Isolated build failed: ${buildLog.slice(-10000)}`);
    const buildMs = Date.now() - started;
    server = spawn(process.execPath, [cli, "start", app, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = "";
    server.stdout.on("data", (chunk) => { serverLog += chunk; }); server.stderr.on("data", (chunk) => { serverLog += chunk; });
    const deadline = Date.now() + 45000;
    while (true) {
      if (server.exitCode !== null) throw new Error(`Isolated server exited: ${serverLog.slice(-3000)}`);
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error("Isolated server did not start");
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return { origin, buildMs, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

module.exports = { isolatedNext, listen };
