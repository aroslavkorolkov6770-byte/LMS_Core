"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), { execFile } = require("node:child_process"), { promisify } = require("node:util");
const run = promisify(execFile);
async function stop() {
  const logical = process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.env.APPDATA, "LMS Core Desktop/workspace");
  let root;
  try { root = await fs.realpath(logical); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const config = path.join(root, "apps/control-center/config/launcher-config.json");
  try { await fs.access(config); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  // The normal lifecycle script verifies PID/start time and PostgreSQL's own data directory.
  // Do not kill processes by their name or merely because they occupy the expected port.
  for (const service of ["deploy-panel", "api", "postgres"]) {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "infra/scripts/control-dev-service.ps1"), "-Action", "Stop", "-ServiceId", service], {
      cwd: root, windowsHide: true, timeout: 60000, env: { ...process.env, CORE_PG_BIN: path.join(__dirname, "tools/postgres/bin") }
    });
    const result = stdout.trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line.replace(/^\uFEFF/, ""))]; } catch { return []; } }).find(value => value.id === service);
    if (!result || result.running || result.ok === false) throw Error("DESKTOP_STOP_UNCONFIRMED");
  }
}
void stop().catch(() => { process.stderr.write("DESKTOP_STOP_UNCONFIRMED\n"); process.exitCode = 1; });
