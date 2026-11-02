"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const assert = require("node:assert/strict");
const { randomUUID, X509Certificate } = require("node:crypto");
const exec = require("node:util").promisify(require("node:child_process").execFile);
const worker = require("../../scripts/publish-lms-ip.cjs");
const base = "/opt/lms-core-https-fixtures";

async function issue(root, c, days = 7) {
  const p = worker.tlsPaths(c), disk = name => path.join(root, name), serial = Date.now();
  const archive = disk(`${p.config}/archive/${p.name}`), live = disk(`${p.config}/live/${p.name}`);
  await fs.mkdir(archive, { recursive: true, mode: 0o700 }); await fs.mkdir(live, { recursive: true, mode: 0o700 });
  const key = path.join(archive, `privkey${serial}.pem`), csr = path.join(root, `request-${serial}.csr`), cert = path.join(archive, `fullchain${serial}.pem`), extension = path.join(root, "leaf.ext");
  await fs.writeFile(extension, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${c.host}\n`);
  await exec("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Core local HTTPS test", "-keyout", key, "-out", csr]);
  await exec("openssl", ["x509", "-req", "-in", csr, "-CA", path.join(root, "ca.pem"), "-CAkey", path.join(root, "ca.key"), "-set_serial", String(serial), "-days", String(days), "-extfile", extension, "-out", cert]);
  await fs.appendFile(cert, await fs.readFile(path.join(root, "ca.pem"))); await fs.chmod(key, 0o600);
  for (const [name, target] of [["fullchain.pem", cert], ["privkey.pem", key]]) {
    const destination = path.join(live, name), temporary = destination + "." + randomUUID();
    await fs.symlink(target, temporary); await fs.rename(temporary, destination);
  }
}

async function renew(root) {
  assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith("test-"));
  const context = JSON.parse(await fs.readFile(path.join(root, "fixture-context.json"), "utf8"));
  assert.equal(context.root, root);
  await issue(root, context.c, 10);
  await exec("/bin/sh", [path.join(root, "fixture-reload.sh")]);
  await fs.writeFile(path.join(root, "renewed.json"), JSON.stringify({ clientId: context.c.clientId, renewedAt: new Date().toISOString() }));
}

async function acceptance(output) {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  assert.equal(process.argv[3], "--isolated-network");
  assert.notEqual(await fs.readlink("/proc/self/ns/net"), await fs.readlink("/proc/1/ns/net"), "TLS fixture must not use the existing Linux network namespace");
  await exec("ip", ["link", "set", "lo", "up"]);
  const listeners = (await exec("ss", ["-ltnp"])).stdout;
  assert.equal(listeners.split(/\r?\n/).some(line => /:(?:80|443)\s/.test(line)), false, "Local test ports80/443 are occupied; no service was stopped");
  await fs.mkdir(base, { mode: 0o755, recursive: true });
  const root = await fs.mkdtemp(path.join(base, "test-")), disk = name => path.join(root, name);
  await fs.chmod(root, 0o755);
  const c = { clientId: randomUUID(), jobId: randomUUID(), releaseId: randomUUID(), host: "127.0.0.1", appPath: "/srv/lms-core/clients/tls-fixture", webPort: 3060, acmeAgreement: true };
  const p = worker.tlsPaths(c), r = worker.renewalConfiguration(c), ownUnits = new Set();
  const nginxFile = path.join(root, "nginx.conf"), nginxPid = path.join(root, "nginx.pid");
  let nginxStarted = false, issuingCalls = 0;
  const backend = http.createServer((request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; upgrade-insecure-requests");
    if (request.url === "/api/core-runtime/health") response.end(JSON.stringify({ protocol: "lms-core-client-v1", status: "ok", clientId: c.clientId, releaseId: c.releaseId }));
    else if (request.method === "POST") {
      if (request.headers.origin !== `http://127.0.0.1:${c.webPort}`) { response.writeHead(403); response.end("rejected"); return; }
      response.setHeader("Set-Cookie", `core_lms_session_${c.clientId.replaceAll("-", "")}=fixture-only; Path=/; Secure; HttpOnly; SameSite=Lax`); response.end("accepted");
    } else if (request.url === "/fixture.css") { response.setHeader("Content-Type", "text/css"); response.end("body{color:#123456}"); }
    else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><title>Core HTTPS fixture</title><link rel="stylesheet" href="/fixture.css"><main>Local HTTPS</main>'); }
  });
  async function syncNginx() {
    const directory = disk("/etc/nginx/conf.d"), active = path.join(root, "active-config"); await fs.mkdir(active, { recursive: true });
    for (const file of await fs.readdir(directory)) if (file.endsWith(".conf")) {
      const value = await fs.readFile(path.join(directory, file), "utf8");
      await fs.writeFile(path.join(active, file), value.replaceAll("/etc/lms-core/", root + "/etc/lms-core/").replaceAll("/var/www/lms-core-acme/", root + "/var/www/lms-core-acme/"));
    }
  }
  const nginx = async args => { await syncNginx(); return (await exec("/usr/sbin/nginx", ["-p", root + "/", "-c", nginxFile, ...args], { timeout: 30000 })).stdout; };
  async function syncUnits() {
    for (const suffix of [".service", ".timer"]) {
      const logical = `/etc/systemd/system/${r.unit}${suffix}`, source = disk(logical);
      let body;
      try { body = await fs.readFile(source, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; continue; }
      const actual = logical;
      try { assert.ok((await fs.readFile(actual, "utf8")).startsWith(`# Core local TLS fixture:${c.clientId}\n`)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (suffix === ".service") body = body.replace(/^ExecStart=.*$/m, `NetworkNamespacePath=/proc/${process.pid}/ns/net\nExecStart=${process.execPath} "${__filename}" --renew ${root}`);
      await fs.writeFile(actual, `# Core local TLS fixture:${c.clientId}\n` + body, { mode: 0o644 }); ownUnits.add(actual);
    }
  }
  const run = async (file, args) => {
    if (file === "nginx") return (await nginx(args)).replaceAll(root + "/active-config/", "/etc/nginx/conf.d/");
    if (file === "ufw") return "Status: inactive\n";
    if (file === p.certbot) {
      issuingCalls++;
      assert.ok(args.includes("--ip-address") && args.includes("shortlived"));
      if (!args.includes("--dry-run")) await issue(root, c);
      return "";
    }
    if (file === "systemctl" && args.at(-1) === "nginx") {
      if (args[0] === "enable") { await nginx([]); nginxStarted = true; } else if (args[0] === "reload") await nginx(["-s", "reload"]); else throw Error("Unexpected global Nginx command");
      return "";
    }
    if (file === "systemctl" && args[0] === "daemon-reload") await syncUnits();
    if (file === "systemctl") {
      assert.ok(args[0] === "daemon-reload" || args.some(arg => arg === r.unit + ".timer" || arg === r.unit + ".service"));
      return (await exec(file, args, { timeout: 45000 })).stdout;
    }
    return (await exec(file, args, { timeout: 45000 })).stdout;
  };
  try {
    for (let port = 3060; port < 3099; port++) {
      try { await new Promise((resolve, reject) => { backend.once("error", reject); backend.listen(port, "127.0.0.1", resolve); }); c.webPort = port; break; } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
    }
    assert.ok(c.webPort);
    for (const name of [c.appPath, "/etc/nginx/conf.d", "/etc/systemd/system"]) await fs.mkdir(disk(name), { recursive: true, mode: 0o755 });
    await fs.writeFile(disk(c.appPath + "/.core-install-owner.json"), JSON.stringify({ ...c, state: "installed" }), { mode: 0o600 });
    await fs.writeFile(disk("/etc/nginx/nginx.conf"), "include /etc/nginx/conf.d/*.conf;\n");
    await fs.writeFile(nginxFile, `pid ${nginxPid};\nerror_log ${root}/nginx.error.log;\nevents{}\nhttp{access_log off;include ${root}/active-config/*.conf;}\n`);
    await fs.writeFile(path.join(root, "fixture-context.json"), JSON.stringify({ root, c }), { mode: 0o600 });
    await fs.writeFile(path.join(root, "fixture-reload.sh"), `#!/bin/sh\n# Core local TLS fixture:${c.clientId}\nset -eu\n/usr/sbin/nginx -p ${root}/ -c ${nginxFile} -t\n/usr/sbin/nginx -p ${root}/ -c ${nginxFile} -s reload\n`, { mode: 0o700 });
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=Core isolated test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", path.join(root, "ca.key"), "-out", path.join(root, "ca.pem")]);
    const ca = await fs.readFile(path.join(root, "ca.pem")), options = { fixture: true, root, run, ca };
    const httpResult = await worker.publishIp(c, options); assert.equal(httpResult.phase, "succeeded", JSON.stringify(httpResult));
    const result = await worker.enableIpHttps(c, options); assert.equal(result.phase, "succeeded", JSON.stringify(result)); assert.equal(result.autoRenew, true);
    async function tlsRequest(url, init = {}) {
      return new Promise((resolve, reject) => {
        const request = https.request(url, { ca, method: init.method || "GET", headers: init.headers }, response => {
          const data = []; response.on("data", value => data.push(value)); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(data).toString("utf8") })); response.on("error", reject);
        }); request.on("error", reject); request.setTimeout(5000, () => request.destroy(Error("Local TLS timeout"))); request.end(init.body);
      });
    }
    assert.match((await tlsRequest("https://127.0.0.1/")).text, /Local HTTPS/);
    const css = await tlsRequest("https://127.0.0.1/fixture.css"); assert.equal(css.status, 200); assert.match(css.text, /#123456/);
    const post = await tlsRequest("https://127.0.0.1/api/auth", { method: "POST", headers: { Origin: "https://127.0.0.1" }, body: "fixture" });
    assert.equal(post.status, 200); assert.match(post.headers["set-cookie"].join(), /Secure/);
    assert.equal((await tlsRequest("https://127.0.0.1/api/auth", { method: "POST", headers: { Origin: "https://foreign.invalid" } })).status, 403);
    const redirect = await worker.localHttpResponse("http://127.0.0.1/"); assert.equal(redirect.status, 308); assert.equal(redirect.headers.get("location"), "https://127.0.0.1/");
    await assert.rejects(worker.httpsHealth(c), /certificate|issuer|self.signed|verify/i);
    await assert.rejects(worker.httpsHealth({ ...c, host: "192.0.2.1" }, ca));
    assert.equal((await worker.checkIpPublication(c, options)).protocol, "https");
    const before = await worker.inspectIpCertificate(c, options);
    await exec("systemctl", ["start", r.unit + ".service"], { timeout: 45000 });
    let after;
    for (let attempt = 0; ; attempt++) {
      after = await worker.checkIpPublication(c, options);
      if (after.phase === "succeeded" && after.expiresAt !== before.expiresAt) break;
      if (attempt > 40) throw Error("Local renewal not reloaded: " + JSON.stringify(after)); await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(after.renewalState, "ok"); assert.equal(after.autoRenew, true);
    const issuedBefore = issuingCalls;
    assert.equal((await worker.enableIpHttps(c, options)).phase, "succeeded"); assert.equal(issuingCalls, issuedBefore);
    const receipt = { checkedAt: new Date().toISOString(), realLinuxNginxTls: true, trustedFixtureCa: true, untrustedCaAndWrongSanRejected: true, assets: true, originAndSecureCookie: true, httpRedirectAndAcmeWebroot: true, realSystemdTimerAndRenewService: true, renewedCertificateReloaded: true, refreshedExpiry: true, repeatWithoutIssuance: true, externalAcmeOrVpsRequests: 0 };
    await fs.writeFile(path.join(output, "linux-tls-receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
  } catch (error) {
    await fs.copyFile(path.join(root, "nginx.error.log"), path.join(output, "linux-nginx-error.log")).catch(() => {});
    throw error;
  } finally {
    if (ownUnits.size) {
      await exec("systemctl", ["disable", "--now", r.unit + ".timer"], { timeout: 30000 }).catch(() => {});
      await exec("systemctl", ["stop", r.unit + ".service"], { timeout: 30000 }).catch(() => {});
      for (const file of ownUnits) { assert.ok((await fs.readFile(file, "utf8")).startsWith(`# Core local TLS fixture:${c.clientId}\n`)); await fs.unlink(file); }
      await exec("systemctl", ["daemon-reload"]);
    }
    if (nginxStarted) { await nginx(["-s", "quit"]).catch(() => {}); }
    backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
    if (nginxStarted) for (let attempt = 0; attempt < 50; attempt++) { try { await fs.access(nginxPid); await new Promise(resolve => setTimeout(resolve, 100)); } catch (error) { if (error.code === "ENOENT") break; throw error; } }
    assert.equal(path.dirname(await fs.realpath(root)), base); assert.ok(path.basename(root).startsWith("test-")); await fs.rm(root, { recursive: true, force: true });
  }
}
if (process.argv[2] === "--renew") renew(process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
else acceptance(process.argv[2]).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
