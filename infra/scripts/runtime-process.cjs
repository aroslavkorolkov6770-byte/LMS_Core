"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function sealSecrets(secrets, key, identity) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(identity));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
function openSecrets(envelope, key, identity) {
  try {
    if (envelope.v !== 1) throw Error("Invalid version");
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    cipher.setAAD(Buffer.from(identity)); cipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, "base64")), cipher.final()]).toString("utf8"));
  } catch { throw Error("RUNTIME_VAULT_INTEGRITY_FAILED"); }
}
function systemEnvironment() {
  return Object.fromEntries(["PATH", "HOME", "TEMP", "TMP", "TMPDIR", "SystemRoot", "COMSPEC", "LANG", "LC_ALL", "TZ"].filter((key) => typeof process.env[key] === "string").map((key) => [key, process.env[key]]));
}
function roleEnvironment(context, secrets, role) {
  const common = { ...systemEnvironment(), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
  if (role === "api") return { ...common, DATABASE_URL: secrets.databaseUrl, LMS_RUNTIME_CLIENT_ID: context.clientId,
    LMS_RUNTIME_SERVICE_TOKEN: secrets.serviceToken, LMS_RUNTIME_ENCRYPTION_KEY: secrets.encryptionKey, LMS_RUNTIME_BOOTSTRAP_ENABLED: "false",
    LMS_RUNTIME_LISTEN_HOST: "127.0.0.1", LMS_RUNTIME_PORT: String(context.apiPort), LMS_RUNTIME_REQUIRE_RESTRICTED_ROLE: "true" };
  if (role === "web") return { ...common, AUTH_SECRET: secrets.authSecret, CORE_RUNTIME_CLIENT_ID: context.clientId, CORE_RUNTIME_RELEASE_ID: context.releaseId,
    APP_ORIGIN: `http://127.0.0.1:${context.webPort}`, CORE_RUNTIME_SERVICE_TOKEN: secrets.serviceToken, CORE_RUNTIME_API_URL: `http://127.0.0.1:${context.apiPort}`,
    ...(context.designSha256 ? { CORE_RUNTIME_DESIGN_SHA256: context.designSha256 } : {}) };
  throw Error("INVALID_RUNTIME_ROLE");
}
function serve(contextFile, role) {
  const context = JSON.parse(fs.readFileSync(contextFile, "utf8"));
  const base = path.dirname(contextFile);
  const secrets = openSecrets(JSON.parse(fs.readFileSync(path.join(base, "runtime-vault.json"), "utf8")), fs.readFileSync(path.join(base, "runtime-vault.key")), context.clientId);
  const cwd = path.join(context.releaseRoot, role === "api" ? "backend" : "lms");
  if (role === "web" && context.designSha256) {
    const contract = require(path.join(cwd, "core-client-design-contract.cjs"));
    const file = path.join(cwd, "core-client-design.json");
    if (fs.statSync(file).size > contract.MAX_BYTES) throw Error("CLIENT_DESIGN_INVALID");
    const design = contract.validateClientDesign(JSON.parse(fs.readFileSync(file, "utf8")));
    if (design.clientId !== context.clientId || contract.designHash(design) !== context.designSha256) throw Error("CLIENT_DESIGN_INVALID");
    for (const asset of design.assets || []) {
      const file = path.join(cwd, "public", asset.path), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== asset.sha256) throw Error("CLIENT_DESIGN_ASSET_CHANGED");
    }
  }
  const args = role === "api" ? [path.join(cwd, "runtime-api.cjs")] : [path.join(cwd, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(context.webPort)];
  const child = spawn(process.execPath, args, { cwd, env: roleEnvironment(context, secrets, role), stdio: "inherit", windowsHide: true });
  child.on("error", () => { process.stderr.write("RUNTIME_CHILD_START_FAILED\n"); process.exitCode = 1; });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
}
module.exports = { sealSecrets, openSecrets, roleEnvironment, systemEnvironment };
if (require.main === module) {
  try { serve(process.argv[2], process.argv[3]); }
  catch { process.stderr.write("RUNTIME_WRAPPER_CONFIGURATION_FAILED\n"); process.exitCode = 1; }
}
