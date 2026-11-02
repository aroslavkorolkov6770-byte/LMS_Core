"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function configuration(serviceId, mode, root = path.resolve(__dirname, "../..")) {
  if (!["lms-web", "deploy-panel"].includes(serviceId) || !["dev", "start"].includes(mode)) throw Error("INVALID_LOCAL_NEXT_SERVICE");
  const config = JSON.parse(fs.readFileSync(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8").replace(/^\uFEFF/, ""));
  const service = config.services.find((item) => item.id === serviceId);
  if (!service || !Number.isInteger(service.port) || service.port < 1024 || service.port > 65535 ||
      config.services.some((item) => item.id !== serviceId && item.port === service.port)) throw Error("INVALID_LOCAL_NEXT_PORT");
  const preview = config.services.find((item) => item.id === "lms-web");
  if ((!preview && process.env.CORE_DESKTOP_MODE !== "1") || preview && (!Number.isInteger(preview.port) || preview.port < 1024 || preview.port > 65535)) throw Error("INVALID_LOCAL_PREVIEW_PORT");
  return { directory: path.join(root, "apps", serviceId), port: service.port, origin: `http://127.0.0.1:${service.port}`, previewOrigin: `http://127.0.0.1:${preview?.port || 3100}` };
}

function launch(serviceId, mode) {
  const settings = configuration(serviceId, mode);
  const next = require.resolve("next/dist/bin/next", { paths: [settings.directory] });
  const child = spawn(process.execPath, [next, mode, "--hostname", "127.0.0.1", "--port", String(settings.port)], {
    cwd: settings.directory, windowsHide: true, stdio: "inherit",
    env: { ...process.env, CORE_LMS_PREVIEW_ORIGIN: settings.previewOrigin, NEXT_PUBLIC_LMS_PREVIEW_ORIGIN: settings.previewOrigin }
  });
  child.once("error", () => { process.stderr.write("LOCAL_NEXT_START_FAILED\n"); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
}

module.exports = { configuration };
if (require.main === module) {
  try { launch(process.argv[2], process.argv[3]); }
  catch { process.stderr.write("LOCAL_NEXT_CONFIGURATION_FAILED\n"); process.exitCode = 1; }
}
