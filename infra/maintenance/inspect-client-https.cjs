"use strict";
const path = require("node:path"), fs = require("node:fs/promises");
const { app, safeStorage } = require("electron");
app.setPath("userData", path.join(app.getPath("appData"), "@lms-core/control-center"));
const root = path.resolve(__dirname, "../..");
const { ClientServerStore } = require(path.join(root, "apps/control-center/dist/client-servers.js"));
const { ClientInstallationAccessStore } = require(path.join(root, "apps/control-center/dist/client-installation-access.js"));
const { RemoteTargetService } = require(path.join(root, "apps/control-center/dist/remote-target.js"));

async function inspectHttps(input) {
  const fs = require("node:fs/promises"), https = require("node:https"), dns = require("node:dns/promises");
  const run = require("node:util").promisify(require("node:child_process").execFile);
  const output = { readOnly: true, checkedAt: new Date().toISOString(), network: {} };
  for (const host of ["acme-staging-v02.api.letsencrypt.org", "acme-v02.api.letsencrypt.org"]) {
    const result = {};
    try { result.dns = await dns.lookup(host, { all: true }); } catch (error) { result.dnsError = error.code; }
    for (const family of [4, 6]) result["ipv" + family] = await new Promise(resolve => {
      const started = Date.now(); let finished = false;
      const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve({ ...value, elapsedMs: Date.now() - started }); } };
      const request = https.get({ hostname: host, path: "/directory", family, agent: false }, response => {
        response.resume(); finish({ status: response.statusCode });
      });
      const timer = setTimeout(() => { finish({ errorCode: "NETWORK_TIMEOUT" }); request.destroy(); }, 12000);
      request.on("error", error => finish({ errorCode: /^[A-Z_0-9]{1,80}$/.test(error.code || "") ? error.code : "TLS_CONNECTION_FAILED" }));
    });
    output.network[host] = result;
  }
  const base = `/etc/lms-core/acme/${input.clientId}`;
  try {
    const log = await fs.readFile(base + "/logs/letsencrypt.log", "utf8");
    output.certbotLog = { bytes: Buffer.byteLength(log), signals: ["ReadTimeout", "ConnectTimeout", "ConnectionError", "SSLError", "NameResolutionError", "Network is unreachable", "Connection refused", "Timeout during connect", "rateLimited", "unauthorized"].filter(signal => log.includes(signal)),
      endpoints: [...new Set([...log.matchAll(/https:\/\/(acme[^/\s]*\.letsencrypt\.org)(\/[^\s'"?]*)?/g)].map(match => match[1] + (match[2] || "")))].slice(-12) };
  } catch (error) { output.certbotLog = { code: error.code }; }
  try {
    const code = `import json,requests\nresults={}\nfor host in ['acme-staging-v02.api.letsencrypt.org','acme-v02.api.letsencrypt.org']:\n try:\n  response=requests.get('https://'+host+'/directory',timeout=(8,12));results[host]={'status':response.status_code}\n except Exception as e:results[host]={'errorType':type(e).__name__}\nprint(json.dumps(results))`;
    output.certbotPython = JSON.parse((await run("/opt/lms-core/certbot/bin/python", ["-c", code], { timeout: 50000, maxBuffer: 16384 })).stdout);
  } catch { output.certbotPython = { failed: true }; }
  try { const value = JSON.parse(await fs.readFile(`/srv/lms-core/publications/${input.clientId}/result.json`, "utf8")); output.publication = Object.fromEntries(["clientId", "jobId", "releaseId", "phase", "protocol", "errorCode", "failedStep", "rollback", "updatedAt"].map(key => [key, value[key]])); }
  catch { output.publication = { unavailable: true }; }
  return output;
}

app.whenReady().then(async () => {
  const [clientId, host] = process.argv.slice(2);
  if (!/^[a-f0-9-]{36}$/.test(clientId || "")) throw Error("INVALID_CLIENT");
  const state = JSON.parse(await fs.readFile(path.join(root, "infra/runtime/new-deployments", clientId + ".json"), "utf8"));
  if (state.clientId !== clientId || state.phase !== "succeeded" || state.target.host !== host || !state.target.fingerprint) throw Error("TARGET_CHANGED");
  const protector = { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) };
  const store = new ClientServerStore(path.join(app.getPath("userData"), "client-servers"), protector);
  const access = new ClientInstallationAccessStore(path.join(app.getPath("userData"), "installation-access"), protector);
  const remote = new RemoteTargetService(root, undefined, async (target, auth) => (await store.get(clientId, target)).passwordSaved ? store.credentials(target, auth) : access.sshCredentials(target, auth));
  const script = `(${inspectHttps.toString()})(${JSON.stringify({ clientId })}).then(r=>process.stdout.write(JSON.stringify(r))).catch(()=>process.stdout.write(JSON.stringify({readOnly:true,failed:true})));`;
  console.log(await remote.withSession(state.target, { mode: "password", savedForClient: clientId }, session => session.execute("node -", script, 150000)));
  app.quit();
}).catch(() => { console.error("HTTPS_DIAGNOSTIC_FAILED"); app.exit(1); });
