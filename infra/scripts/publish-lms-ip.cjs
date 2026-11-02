"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { isIP } = require("node:net");
const { execFile } = require("node:child_process");
const http = require("node:http");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ACME_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
const ACME_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";

function demand(value, code) { if (!value) throw Object.assign(Error(code), { code }); }
function checkAcmeDirectory(address, options = {}) {
  demand([ACME_STAGING, ACME_PRODUCTION].includes(address), "ACME_DIRECTORY_INVALID");
  const url = new URL(address), get = options.get || require("node:https").get;
  return new Promise(resolve => {
    let settled = false, timer;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    try {
      // Use the official hostname and normal CA/hostname verification; never a pinned IP or insecure TLS.
      const request = get({ hostname: url.hostname, path: url.pathname, family: 4, agent: false }, response => {
        let body = "";
        response.on("error", () => finish({ ready: false, unavailable: true, errorCode: "ACME_CONNECTION_FAILED" }));
        if (response.statusCode >= 500 || response.statusCode === 429) { response.resume(); finish({ ready: false, unavailable: true, errorCode: "ACME_CONNECTION_FAILED" }); return; }
        response.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 65536) { finish({ ready: false, errorCode: "ACME_DIRECTORY_INVALID" }); request.destroy(); } });
        response.on("end", () => {
          try {
            const directory = JSON.parse(body);
            demand(response.statusCode === 200 && ["newNonce", "newAccount", "newOrder"].every(key => new URL(directory[key]).origin === url.origin), "ACME_DIRECTORY_INVALID");
            demand(directory.meta?.profiles && Object.hasOwn(directory.meta.profiles, "shortlived"), "ACME_PROFILE_UNAVAILABLE");
            finish({ ready: true });
          } catch (error) { finish({ ready: false, errorCode: error.code === "ACME_PROFILE_UNAVAILABLE" ? error.code : "ACME_DIRECTORY_INVALID" }); }
        });
      });
      timer = setTimeout(() => { finish({ ready: false, unavailable: true, errorCode: "ACME_CONNECTION_FAILED" }); request.destroy(); }, options.timeout || 8000);
      request.on("error", error => {
        const unavailable = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(error.code);
        finish({ ready: false, unavailable, errorCode: unavailable ? "ACME_CONNECTION_FAILED" : "ACME_DIRECTORY_TLS_FAILED" });
      });
    } catch { finish({ ready: false, errorCode: "ACME_DIRECTORY_TLS_FAILED" }); }
  });
}
function localHttpResponse(address, init = {}) {
  const url = new URL(address);
  demand(url.protocol === "http:" && url.hostname === "127.0.0.1", "PUBLICATION_HEALTH_URL_INVALID");
  // Node fetch ignores a supplied Host header; http.request preserves the exact virtual host.
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method || "GET", headers: init.headers }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > 65536) response.destroy(Error("PUBLICATION_RESPONSE_TOO_LARGE")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
          headers: { get: (name) => { const value = response.headers[name.toLowerCase()]; return value === undefined ? null : Array.isArray(value) ? value.join(", ") : value; } },
          json: async () => JSON.parse(text), text: async () => text });
      });
    });
    request.setTimeout(15000, () => request.destroy(Error("PUBLICATION_HEALTH_TIMEOUT")));
    request.on("error", reject); request.end(init.body);
  });
}
function validatePublication(input) {
  demand(input && ["clientId", "jobId", "releaseId"].every((key) => UUID.test(input[key])) && isIP(input.host) === 4 &&
    /^\/srv\/lms-core\/clients\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.appPath) &&
    Number.isInteger(input.webPort) && input.webPort >= 3000 && input.webPort <= 3099, "PUBLICATION_INPUT_INVALID");
  return { clientId: input.clientId, jobId: input.jobId, releaseId: input.releaseId, host: input.host, appPath: input.appPath, webPort: input.webPort };
}

function nginxConfiguration(input, challenge = false) {
  const c = validatePublication(input), suffix = c.clientId.replaceAll("-", ""), upstream = `http://127.0.0.1:${c.webPort}`;
  const capture = "csp_" + suffix.slice(0, 20);
  return `# LMS Core HTTP test client:${c.clientId}\n# job:${c.jobId} release:${c.releaseId}\n` +
    `map $http_origin $core_origin_${suffix} {\n    default $http_origin;\n    "http://${c.host}" "${upstream}";\n    "http://${c.host}:80" "${upstream}";\n}\n` +
    `map $upstream_http_content_security_policy $core_http_csp_${suffix} {\n    default $upstream_http_content_security_policy;\n    "~^\\s*upgrade-insecure-requests\\s*;?\\s*$" "";\n    "~^(?<${capture}>.*);\\s*upgrade-insecure-requests\\s*;?\\s*$" $${capture};\n}\n` +
    `server {\n    listen 80;\n    server_name ${c.host};\n    if ($host != "${c.host}") { return 421; }\n    server_tokens off;\n    client_max_body_size 50m;\n` +
    `    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;\n    add_header X-Content-Type-Options nosniff always;\n` +
    (challenge ? `    location ^~ /.well-known/acme-challenge/ { root ${tlsPaths(c).webroot}; try_files $uri =404; }\n` : "") +
    `    location / {\n        proxy_pass ${upstream};\n        proxy_http_version 1.1;\n        proxy_set_header Host "127.0.0.1:${c.webPort}";\n` +
    `        proxy_set_header Origin $core_origin_${suffix};\n        proxy_set_header X-Forwarded-Host "127.0.0.1:${c.webPort}";\n        proxy_set_header X-Forwarded-Proto http;\n        proxy_set_header X-Forwarded-For $remote_addr;\n        proxy_set_header Forwarded "";\n        proxy_set_header Connection "";\n` +
    `        proxy_hide_header Content-Security-Policy;\n        proxy_hide_header Strict-Transport-Security;\n        add_header Content-Security-Policy $core_http_csp_${suffix} always;\n        add_header X-Robots-Tag "noindex, nofollow, noarchive" always;\n        add_header X-Content-Type-Options nosniff always;\n        proxy_cookie_flags core_lms_session_${suffix} nosecure httponly samesite=lax;\n        proxy_redirect ${upstream}/ http://${c.host}/;\n        proxy_buffering off;\n        proxy_read_timeout 120s;\n    }\n}\n`;
}

async function publishIp(input, options = {}) {
  const c = validatePublication(input);
  demand(options.fixture || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const disk = (name) => options.root ? path.join(options.root, name) : name;
  const run = options.run || (async (file, args, timeout = 30000) => (await exec(file, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } })).stdout);
  const fetcher = options.fetch || localHttpResponse;
  const safeFile = async (file) => {
    const s = await fs.lstat(file);
    demand(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 1024 * 1024 && (options.fixture || s.uid === 0 && !(s.mode & 0o022)), "PUBLICATION_FILE_UNSAFE");
    return fs.readFile(file, "utf8");
  };
  const safeDirectory = async (directory, create = false) => {
    if (options.root && directory === path.resolve(options.root)) return;
    const parent = path.dirname(directory);
    if (parent !== directory) await safeDirectory(parent, create);
    try { if (create) await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const s = await fs.lstat(directory);
    demand(s.isDirectory() && !s.isSymbolicLink() && (options.fixture || s.uid === 0 && !(s.mode & 0o022)), "PUBLICATION_PATH_UNSAFE");
  };
  const health = async (url, headers) => {
    const response = await fetcher(url + "/api/core-runtime/health", { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
    const value = await response.json();
    demand(response.ok && value.protocol === "lms-core-client-v1" && value.status === "ok" && value.clientId === c.clientId && value.releaseId === c.releaseId, "PUBLICATION_HEALTH_FAILED");
  };
  await safeDirectory(disk(c.appPath));
  const owner = JSON.parse(await safeFile(disk(c.appPath + "/.core-install-owner.json")));
  demand(owner.state === "installed" && owner.clientId === c.clientId && owner.jobId === c.jobId && owner.releaseId === c.releaseId, "PUBLICATION_OWNER_MISMATCH");
  await health(`http://127.0.0.1:${c.webPort}`);
  const directory = disk(`/srv/lms-core/publications/${c.clientId}`);
  await safeDirectory(directory, true);
  const lockFile = path.join(directory, "publish.lock");
  let lock;
  try { lock = await fs.open(lockFile, "wx", 0o600); } catch (error) { demand(error.code !== "EEXIST", "PUBLICATION_BUSY"); throw error; }
  const file = disk(`/etc/nginx/conf.d/lms-core-${c.clientId}.conf`), expected = nginxConfiguration(c);
  let previous = null, changed = false, firewallAdded = false, stage = "preflight";
  try {
    await lock.writeFile(JSON.stringify({ jobId: c.jobId, startedAt: new Date().toISOString() }));
    const listeners = await run("ss", ["-ltnp"]);
    demand(!listeners.split(/\r?\n/).some((line) => /:80\s/.test(line) && !/nginx/.test(line)), "HTTP_PORT_OCCUPIED");
    let installed = true;
    try { await run("nginx", ["-v"]); } catch (error) { if (error.code === "ENOENT") installed = false; else throw error; }
    if (!installed) {
      stage = "install_nginx";
      await run("apt-get", ["update", "-qq"], 180000);
      await run("apt-get", ["install", "-y", "--no-install-recommends", "nginx"], 180000);
    }
    await safeDirectory(disk("/etc/nginx/conf.d"));
    const main = await safeFile(disk("/etc/nginx/nginx.conf"));
    demand(/include\s+\/etc\/nginx\/conf\.d\/\*\.conf\s*;/.test(main), "NGINX_LAYOUT_UNSUPPORTED");
    try { previous = await safeFile(file); demand(previous.startsWith(`# LMS Core HTTP test client:${c.clientId}\n`), "NGINX_CONFIG_OCCUPIED"); demand(!previous.includes("# LMS Core HTTPS enabled"), "HTTPS_ALREADY_ENABLED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const configuration = await run("nginx", ["-T"]);
    for (const block of configuration.split(/^# configuration file /m).slice(1)) {
      const end = block.indexOf(":\n"), name = block.slice(0, end).trim();
      if (name === `/etc/nginx/conf.d/lms-core-${c.clientId}.conf`) continue;
      demand(![...block.slice(end + 2).matchAll(/\bserver_name\s+([^;]+);/g)].some((match) => match[1].split(/\s+/).includes(c.host)), "NGINX_IP_ALREADY_CONFIGURED");
    }
    stage = "configure";
    if (previous !== expected) {
      if (previous !== null) await fs.writeFile(path.join(directory, `previous-${Date.now()}.conf`), previous, { flag: "wx", mode: 0o600 });
      const temporary = file + "." + c.jobId + ".tmp";
      await fs.writeFile(temporary, expected, { flag: "wx", mode: 0o644 });
      await fs.rename(temporary, file); changed = true;
    }
    await run("nginx", ["-t"]);
    stage = "activate";
    await run("systemctl", ["enable", "--now", "nginx"]);
    await run("systemctl", ["reload", "nginx"]);
    // A successful reload returns before new Nginx workers have accepted traffic.
    let ready = false;
    const deadline = Date.now() + 20000;
    for (let attempt = 0; attempt < 25 && Date.now() < deadline; attempt++) {
      try { await health("http://127.0.0.1", { Host: c.host }); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
    }
    demand(ready, "PUBLICATION_HEALTH_FAILED");
    stage = "firewall";
    let firewall = "not_managed";
    try {
      const status = await run("ufw", ["status"]);
      if (/^Status: active/m.test(status)) {
        const existing = await run("ufw", ["show", "added"]);
        if (!/^ufw allow 80\/tcp(?:\s|$)/m.test(existing)) { await run("ufw", ["allow", "80/tcp"]); firewallAdded = true; }
        firewall = "80/tcp_allowed";
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const result = { clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, host: c.host, phase: "succeeded", url: `http://${c.host}`, updatedAt: new Date().toISOString(), firewall, httpOnlyTest: true };
    await fs.writeFile(path.join(directory, "result.json"), JSON.stringify(result), { mode: 0o600 });
    return result;
  } catch (error) {
    let rollback = true;
    try {
      if (changed) {
        demand(await safeFile(file) === expected, "NGINX_ROLLBACK_CONFLICT");
        if (previous === null) await fs.unlink(file); else await fs.writeFile(file, previous, { mode: 0o644 });
        await run("nginx", ["-t"]); await run("systemctl", ["reload", "nginx"]);
      }
      if (firewallAdded) await run("ufw", ["delete", "allow", "80/tcp"]);
    } catch { rollback = false; }
    const result = { clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, host: c.host, phase: rollback ? "failed" : "needs_attention", updatedAt: new Date().toISOString(), errorCode: /^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "IP_PUBLICATION_FAILED", failedStep: stage, rollback };
    await fs.writeFile(path.join(directory, "result.json"), JSON.stringify(result), { mode: 0o600 });
    return result;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
async function checkIpPublication(input, options = {}) {
  const c = validatePublication(input);
  demand(options.fixture || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const disk = name => options.root ? path.join(options.root, name) : name;
  const file = disk(`/srv/lms-core/publications/${c.clientId}/result.json`);
  const s = await fs.lstat(file);
  demand(s.isFile() && !s.isSymbolicLink() && (options.fixture || s.uid === 0 && !(s.mode & 0o077)) && s.size <= 16384, "PUBLICATION_FILE_UNSAFE");
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  demand(value.clientId === c.clientId && value.jobId === c.jobId && value.releaseId === c.releaseId && value.host === c.host, "PUBLICATION_OWNER_MISMATCH");
  const ownerFile = disk(c.appPath + "/.core-install-owner.json"), ownerStat = await fs.lstat(ownerFile);
  demand(ownerStat.isFile() && !ownerStat.isSymbolicLink() && ownerStat.size <= 16384 && (options.fixture || ownerStat.uid === 0 && !(ownerStat.mode & 0o022)), "PUBLICATION_FILE_UNSAFE");
  const owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
  demand(owner.state === "installed" && owner.clientId === c.clientId && owner.jobId === c.jobId && owner.releaseId === c.releaseId, "PUBLICATION_OWNER_MISMATCH");
  const configuration = await fs.readFile(disk(`/etc/nginx/conf.d/lms-core-${c.clientId}.conf`), "utf8");
  if (configuration === nginxHttpsConfiguration(c)) {
    const status = { ...value, protocol: "https", url: `https://${c.host}`, httpOnlyTest: false, updatedAt: new Date().toISOString() };
    try {
      const certificate = await inspectIpCertificate(c, options);
      Object.assign(status, certificate, await renewalStatus(c, options));
      demand(certificate.valid, "TLS_CERTIFICATE_EXPIRED");
      const served = await (options.httpsHealth || httpsHealth)(c, options.ca);
      demand(!served?.fingerprint256 || served.fingerprint256 === certificate.fingerprint256, "TLS_CERTIFICATE_NOT_RELOADED");
      demand(status.autoRenew, "TLS_RENEWAL_NOT_ACTIVE");
      demand(status.renewalState !== "failed", "TLS_RENEWAL_FAILED");
      status.phase = "succeeded"; delete status.errorCode; delete status.failedStep;
      return status;
    } catch (error) {
      return { ...status, phase: "needs_attention", errorCode: /^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "TLS_CHECK_FAILED" };
    }
  }
  demand(configuration === nginxConfiguration(c) || configuration === nginxConfiguration(c, true), "NGINX_CONFIG_CHANGED");
  const response = await (options.fetch || localHttpResponse)("http://127.0.0.1/api/core-runtime/health", { headers: { Host: c.host } });
  const body = await response.json();
  demand(response.ok && body.protocol === "lms-core-client-v1" && body.status === "ok" && body.clientId === c.clientId && body.releaseId === c.releaseId, "PUBLICATION_HEALTH_FAILED");
  const result = { ...value, phase: "succeeded", protocol: "http", url: `http://${c.host}`, httpOnlyTest: true, updatedAt: new Date().toISOString() };
  // A failed HTTPS attempt may have correctly restored HTTP. A fresh check must allow retry without re-publishing.
  delete result.errorCode; delete result.failedStep; delete result.rollback;
  return result;
}
function tlsPaths(c) {
  const base = `/etc/lms-core/acme/${c.clientId}`;
  const name = `lms-core-${c.clientId}`;
  return { base, name, config: `${base}/config`, work: `${base}/work`, logs: `${base}/logs`, webroot: `/var/www/lms-core-acme/${c.clientId}`,
    certificate: `${base}/config/live/${name}/fullchain.pem`, key: `${base}/config/live/${name}/privkey.pem`, certbot: "/opt/lms-core/certbot/bin/certbot" };
}

function nginxHttpsConfiguration(input) {
  const c = validatePublication(input), p = tlsPaths(c), suffix = c.clientId.replaceAll("-", ""), upstream = `http://127.0.0.1:${c.webPort}`;
  return `# LMS Core HTTP test client:${c.clientId}\n# LMS Core HTTPS enabled\n# job:${c.jobId} release:${c.releaseId}\n` +
    `map $http_origin $core_origin_${suffix} { default $http_origin; "https://${c.host}" "${upstream}"; "https://${c.host}:443" "${upstream}"; }\n` +
    `server { listen 80; server_name ${c.host}; if ($host != "${c.host}") { return 421; }\n    location ^~ /.well-known/acme-challenge/ { root ${p.webroot}; try_files $uri =404; }\n    location / { return 308 https://${c.host}$request_uri; }\n}\n` +
    `server { listen 443 ssl; server_name ${c.host}; if ($host != "${c.host}") { return 421; }\n    ssl_certificate ${p.certificate};\n    ssl_certificate_key ${p.key};\n    ssl_protocols TLSv1.2 TLSv1.3;\n    server_tokens off; client_max_body_size 50m;\n` +
    `    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;\n    add_header X-Content-Type-Options nosniff always;\n    location / {\n        proxy_pass ${upstream};\n        proxy_http_version 1.1;\n        proxy_set_header Host "127.0.0.1:${c.webPort}";\n        proxy_set_header Origin $core_origin_${suffix};\n        proxy_set_header X-Forwarded-Host "127.0.0.1:${c.webPort}";\n        proxy_set_header X-Forwarded-Proto http;\n        proxy_set_header X-Forwarded-For $remote_addr;\n        proxy_set_header Forwarded "";\n        proxy_set_header Connection "";\n        proxy_cookie_flags core_lms_session_${suffix} secure httponly samesite=lax;\n        proxy_redirect ${upstream}/ https://${c.host}/;\n        proxy_buffering off; proxy_read_timeout 120s;\n    }\n}\n`;
}

function httpsHealth(input, ca) {
  const c = validatePublication(input), tls = require("node:tls");
  return new Promise((resolve, reject) => {
    const request = require("node:https").get({ hostname: "127.0.0.1", port: 443, path: "/api/core-runtime/health", headers: { Host: c.host }, agent: false,
      servername: "", ...(ca ? { ca } : {}), checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(c.host, certificate) }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; if (text.length > 16384) response.destroy(Error("TLS_HEALTH_TOO_LARGE")); });
      response.on("error", reject);
      const certificate = response.socket.getPeerCertificate();
      response.on("end", () => { try { const value = JSON.parse(text); demand(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(certificate.fingerprint256 || ""), "TLS_CERTIFICATE_NOT_CONFIRMED"); demand(response.statusCode === 200 && value.protocol === "lms-core-client-v1" && value.status === "ok" && value.clientId === c.clientId && value.releaseId === c.releaseId, "TLS_HEALTH_FAILED"); resolve({ fingerprint256: certificate.fingerprint256 }); } catch (error) { reject(error); } });
    });
    request.setTimeout(12000, () => request.destroy(Error("TLS_HEALTH_TIMEOUT"))); request.on("error", reject);
  });
}

async function inspectIpCertificate(input, options = {}) {
  const c = validatePublication(input), p = tlsPaths(c), crypto = require("node:crypto");
  const disk = name => options.root ? path.join(options.root, name) : name;
  const archive = path.resolve(disk(`${p.config}/archive/${p.name}`));
  async function bytes(file, privateKey = false) {
    const resolved = await fs.realpath(disk(file)), stat = await fs.lstat(resolved);
    demand(path.dirname(resolved) === archive && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024 &&
      (options.fixture || stat.uid === 0 && !(stat.mode & (privateKey ? 0o077 : 0o022))), privateKey ? "TLS_PRIVATE_KEY_UNSAFE" : "TLS_CERTIFICATE_PATH_UNSAFE");
    return fs.readFile(resolved);
  }
  const certificate = new crypto.X509Certificate(await bytes(p.certificate));
  const key = crypto.createPrivateKey(await bytes(p.key, true));
  demand(certificate.checkIP(c.host) === c.host && certificate.publicKey.export({ type: "spki", format: "der" }).equals(crypto.createPublicKey(key).export({ type: "spki", format: "der" })), "TLS_CERTIFICATE_INVALID");
  const now = options.now ? options.now() : Date.now(), start = Date.parse(certificate.validFrom), end = Date.parse(certificate.validTo);
  demand(Number.isFinite(start) && Number.isFinite(end) && start <= now, "TLS_CERTIFICATE_INVALID");
  return { expiresAt: new Date(end).toISOString(), fingerprint256: certificate.fingerprint256, valid: end > now };
}

function renewalConfiguration(input) {
  const c = validatePublication(input), p = tlsPaths(c), unit = `lms-core-acme-${c.clientId}`, hook = `${p.base}/reload-nginx.sh`, tag = `# LMS Core certificate client:${c.clientId}\n`;
  return { unit, hook, files: [
    [hook, "#!/bin/sh\n" + tag + "set -eu\n/usr/sbin/nginx -t\n/bin/systemctl reload nginx\n", 0o700],
    [`/etc/systemd/system/${unit}.service`, tag + `[Unit]\nDescription=LMS Core certificate renewal\nWants=network-online.target\nAfter=network-online.target\n[Service]\nType=oneshot\nUMask=0077\nTimeoutStartSec=10min\nExecStart=${p.certbot} renew --quiet --non-interactive --cert-name ${p.name} --config-dir ${p.config} --work-dir ${p.work} --logs-dir ${p.logs} --deploy-hook ${hook}\n`, 0o644],
    [`/etc/systemd/system/${unit}.timer`, tag + `[Unit]\nDescription=LMS Core certificate renewal schedule\n[Timer]\nOnCalendar=hourly\nOnBootSec=5min\nRandomizedDelaySec=300\nPersistent=true\nUnit=${unit}.service\n[Install]\nWantedBy=timers.target\n`, 0o644]
  ] };
}

async function renewalStatus(input, options = {}) {
  const c = validatePublication(input), r = renewalConfiguration(c), disk = name => options.root ? path.join(options.root, name) : name;
  const run = options.run || (async (file, args) => (await exec(file, args, { timeout: 30000, maxBuffer: 65536 })).stdout);
  try {
    for (const [name, content] of r.files) {
      const stat = await fs.lstat(disk(name));
      demand(stat.isFile() && !stat.isSymbolicLink() && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)) && await fs.readFile(disk(name), "utf8") === content, "TLS_RENEWAL_UNIT_OCCUPIED");
    }
    const enabled = (await run("systemctl", ["is-enabled", r.unit + ".timer"])).trim() === "enabled";
    const active = (await run("systemctl", ["is-active", r.unit + ".timer"])).trim() === "active";
    const details = await run("systemctl", ["show", r.unit + ".service", "--property=Result,ExecMainStatus,ExecMainStartTimestamp"]);
    const values = Object.fromEntries(details.trim().split(/\r?\n/).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
    return { autoRenew: enabled && active, renewalState: !enabled || !active ? "inactive" : !values.ExecMainStartTimestamp ? "scheduled" : values.Result === "success" && values.ExecMainStatus === "0" ? "ok" : "failed" };
  } catch { return { autoRenew: false, renewalState: "unconfirmed" }; }
}

async function enableIpHttps(input, options = {}) {
  const c = validatePublication(input), p = tlsPaths(c);
  demand(input.acmeAgreement === true, "ACME_AGREEMENT_REQUIRED");
  demand(options.fixture || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const octets = c.host.split(".").map(Number);
  demand(options.fixture || !(octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 ||
    octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && (octets[1] === 168 || octets[1] === 0 && [0, 2].includes(octets[2])) ||
    octets[0] === 198 && ([18, 19].includes(octets[1]) || octets[1] === 51 && octets[2] === 100) || octets[0] === 203 && octets[1] === 0 && octets[2] === 113), "ACME_PUBLIC_IP_REQUIRED");
  const disk = (name) => options.root ? path.join(options.root, name) : name;
  const run = options.run || (async (file, args, timeout = 30000) => (await exec(file, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, DEBIAN_FRONTEND: "noninteractive", LC_ALL: "C" } })).stdout);
  const read = async (file) => {
    const stat = await fs.lstat(file);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024 && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)), "TLS_PATH_UNSAFE");
    return fs.readFile(file, "utf8");
  };
  const directory = async (name, mode = 0o700) => {
    if (options.root && name === path.resolve(options.root)) return;
    const parent = path.dirname(name); if (parent !== name) await directory(parent, mode);
    try { await fs.mkdir(name, { mode }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await fs.lstat(name);
    demand(stat.isDirectory() && !stat.isSymbolicLink() && (options.fixture || stat.uid === 0 && !(stat.mode & 0o022)), "TLS_PATH_UNSAFE");
  };
  await directory(disk(c.appPath));
  const owner = JSON.parse(await read(disk(c.appPath + "/.core-install-owner.json")));
  demand(owner.state === "installed" && owner.clientId === c.clientId && owner.jobId === c.jobId && owner.releaseId === c.releaseId, "PUBLICATION_OWNER_MISMATCH");
  const receiptDir = disk(`/srv/lms-core/publications/${c.clientId}`), configFile = disk(`/etc/nginx/conf.d/lms-core-${c.clientId}.conf`);
  await directory(receiptDir);
  const lockFile = path.join(receiptDir, "publish.lock");
  let lock;
  try { lock = await fs.open(lockFile, "wx", 0o600); } catch (error) { demand(error.code !== "EEXIST", "PUBLICATION_BUSY"); throw error; }
  let previous, current, written = false, firewallAdded = false, stage = "preflight", timerCreated = false, stagingCheck;
  const createdUnits = [];
  const renewal = renewalConfiguration(c);
  // Replace only the exact file we last inspected or wrote; a concurrent edit is not a rollback target.
  async function replaceConfiguration(contents) {
    demand(await read(configFile) === current, "NGINX_CONFIG_CHANGED");
    const temporary = configFile + ".tls-" + require("node:crypto").randomUUID() + ".tmp";
    try { await fs.writeFile(temporary, contents, { flag: "wx", mode: 0o644 }); await fs.rename(temporary, configFile); current = contents; written = true; }
    finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  try {
    await lock.writeFile(JSON.stringify({ jobId: c.jobId, operation: "https", startedAt: new Date().toISOString() }));
    previous = await read(configFile);
    current = previous;
    demand([nginxConfiguration(c), nginxConfiguration(c, true), nginxHttpsConfiguration(c)].includes(previous), "NGINX_CONFIG_OCCUPIED");
    const response = await (options.fetch || localHttpResponse)(`http://127.0.0.1:${c.webPort}/api/core-runtime/health`);
    const body = await response.json();
    demand(response.ok && body.protocol === "lms-core-client-v1" && body.status === "ok" && body.clientId === c.clientId && body.releaseId === c.releaseId, "PUBLICATION_HEALTH_FAILED");
    for (const [name, content] of renewal.files) {
      try { demand(await read(disk(name)) === content, "TLS_RENEWAL_UNIT_OCCUPIED"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    demand(!String(await run("ss", ["-ltnp"])).split(/\r?\n/).some((line) => /:443\s/.test(line) && !/nginx/.test(line)), "HTTPS_PORT_OCCUPIED");
    const allConfig = await run("nginx", ["-T"]);
    for (const block of allConfig.split(/^# configuration file /m).slice(1)) {
      const end = block.indexOf(":\n");
      if (block.slice(0, end).trim() === `/etc/nginx/conf.d/lms-core-${c.clientId}.conf`) continue;
      demand(![...block.slice(end + 2).matchAll(/\bserver_name\s+([^;]+);/g)].some((match) => match[1].split(/\s+/).includes(c.host)), "NGINX_IP_ALREADY_CONFIGURED");
    }
    await directory(disk(p.base)); for (const name of [p.config, p.work, p.logs]) await directory(disk(name));
    await directory(disk(p.webroot), 0o755);
    if (!options.fixture) {
      for (const name of ["/var", "/var/www", "/var/www/lms-core-acme", p.webroot]) demand(((await fs.stat(name)).mode & 0o005) === 0o005, "ACME_WEBROOT_NOT_READABLE");
    }
    stage = "prepare_acme";
    if (!options.fixture) {
      const venv = "/opt/lms-core/certbot", marker = venv + "/.core-owner.json";
      let existed = false;
      try { const value = JSON.parse(await read(marker)); demand(value.owner === "lms-core" && value.version === "5.9.0", "CERTBOT_PATH_OCCUPIED"); existed = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; try { await fs.lstat(venv); throw Object.assign(Error("CERTBOT_PATH_OCCUPIED"), { code: "CERTBOT_PATH_OCCUPIED" }); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      if (!existed) { await directory(venv); await fs.writeFile(marker, JSON.stringify({ owner: "lms-core", version: "5.9.0" }), { flag: "wx", mode: 0o600 }); }
      let ready = false;
      try { ready = /^certbot 5\.9\.0\b/.test((await run(p.certbot, ["--version"])).trim()); } catch {}
      if (!ready) {
        await run("apt-get", ["update", "-qq"], 180000); await run("apt-get", ["install", "-y", "--no-install-recommends", "python3-venv"], 180000);
        await run("python3", ["-m", "venv", venv], 120000);
        await run(venv + "/bin/python", ["-m", "pip", "install", "--disable-pip-version-check", "certbot==5.9.0"], 300000);
      }
      demand(/^certbot 5\.9\.0\b/.test((await run(p.certbot, ["--version"])).trim()), "CERTBOT_VERSION_UNSUPPORTED");
    }
    // Keep the current site live while Certbot writes and validates HTTP-01 tokens.
    if (!previous.includes("# LMS Core HTTPS enabled")) {
      await replaceConfiguration(nginxConfiguration(c, true));
      await run("nginx", ["-t"]); await run("systemctl", ["reload", "nginx"]);
      await new Promise((resolve) => setTimeout(resolve, options.fixture ? 10 : 1000));
    }
    stage = "issue_certificate";
    // Verify that the challenge path is really served before contacting an external CA.
    const token = "core-probe-" + require("node:crypto").randomUUID(), tokenFile = disk(`${p.webroot}/.well-known/acme-challenge/${token}`);
    await directory(path.dirname(tokenFile), 0o755);
    try {
      await fs.writeFile(tokenFile, token, { flag: "wx", mode: 0o644 });
      let served = false; const deadline = Date.now() + 10000;
      for (let attempt = 0; attempt < 25 && Date.now() < deadline; attempt++) {
        try { const check = await (options.fetch || localHttpResponse)(`http://127.0.0.1/.well-known/acme-challenge/${token}`, { headers: { Host: c.host } }); if (check.ok && await check.text() === token) { served = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      demand(served, "ACME_WEBROOT_UNREACHABLE");
    } finally { await fs.unlink(tokenFile).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    const common = ["--non-interactive", "--agree-tos", "--register-unsafely-without-email", "--config-dir", p.config, "--work-dir", p.work, "--logs-dir", p.logs];
    const request = ["certonly", ...common, "--required-profile", "shortlived", "--webroot", "--webroot-path", p.webroot, "--ip-address", c.host, "--cert-name", p.name, "--keep-until-expiring"];
    let certificate;
    try { certificate = await inspectIpCertificate(c, options); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const now = options.now ? options.now() : Date.now();
    if (!certificate || !certificate.valid || Date.parse(certificate.expiresAt) - now < 48 * 3600000) {
      stage = "check_acme_connectivity";
      const probe = options.acmeProbe || checkAcmeDirectory;
      const production = await probe(ACME_PRODUCTION);
      demand(production.ready === true, production.errorCode || "ACME_CONNECTION_FAILED");
      const staging = await probe(ACME_STAGING);
      demand(staging.ready === true || staging.unavailable === true && staging.errorCode === "ACME_CONNECTION_FAILED", staging.errorCode || "ACME_DIRECTORY_INVALID");
      stagingCheck = staging.ready ? "passed" : "unavailable";
      stage = "issue_certificate";
      try {
        // Staging is a rehearsal, not the trust/ownership check. Production still performs HTTP-01 validation.
        if (staging.ready) await run(p.certbot, [...request, "--dry-run", "--server", ACME_STAGING], 240000);
        await run(p.certbot, [...request, "--server", ACME_PRODUCTION], 240000);
      } catch (error) {
        const detail = String(error.stderr || "");
        demand(false, /rate.?limit|too many/i.test(detail) ? "ACME_RATE_LIMITED" : /unauthorized|invalid response|challenge.*fail/i.test(detail) ? "ACME_VALIDATION_FAILED" : /timed? ?out|connection refused|network.*unreachable/i.test(detail) ? "ACME_CONNECTION_FAILED" : "ACME_ISSUANCE_FAILED");
      }
      certificate = await inspectIpCertificate(c, options);
    }
    demand(certificate.valid, "TLS_CERTIFICATE_EXPIRED");
    stage = "activate_https";
    await fs.writeFile(path.join(receiptDir, `previous-https-${Date.now()}.conf`), previous, { flag: "wx", mode: 0o600 });
    await replaceConfiguration(nginxHttpsConfiguration(c));
    await run("nginx", ["-t"]); await run("systemctl", ["reload", "nginx"]);
    let healthy = false;
    for (let attempt = 0; attempt < (options.attempts || 20); attempt++) { try { const served = await (options.httpsHealth || httpsHealth)(c, options.ca); demand(!served?.fingerprint256 || served.fingerprint256 === certificate.fingerprint256, "TLS_CERTIFICATE_NOT_RELOADED"); healthy = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, options.fixture ? 10 : 250)); } }
    demand(healthy, "TLS_HEALTH_FAILED");
    stage = "automatic_renewal";
    const unit = renewal.unit;
    for (const [name, content, mode] of renewal.files) {
      const file = disk(name);
      try { demand(await read(file) === content, "TLS_RENEWAL_UNIT_OCCUPIED"); }
      catch (error) { if (error.code !== "ENOENT") throw error; await fs.writeFile(file, content, { flag: "wx", mode }); createdUnits.push([file, content]); if (name.endsWith(".timer")) timerCreated = true; }
    }
    await run("systemctl", ["daemon-reload"]); await run("systemctl", ["enable", "--now", unit + ".timer"]);
    demand((await run("systemctl", ["is-enabled", unit + ".timer"])).trim() === "enabled" && (await run("systemctl", ["is-active", unit + ".timer"])).trim() === "active", "TLS_RENEWAL_NOT_ACTIVE");
    stage = "firewall";
    try { if (/^Status: active/m.test(await run("ufw", ["status"]))) { const rules = await run("ufw", ["show", "added"]); if (!/^ufw allow 443\/tcp(?:\s|$)/m.test(rules)) { await run("ufw", ["allow", "443/tcp"]); firewallAdded = true; } } } catch (error) { if (error.code !== "ENOENT") throw error; }
    let renewalState = await renewalStatus(c, { ...options, run });
    if (renewalState.renewalState === "failed") {
      await run("systemctl", ["reset-failed", unit + ".service"]);
      await run("systemctl", ["start", unit + ".service"], 660000);
      renewalState = await renewalStatus(c, { ...options, run });
    }
    demand(renewalState.autoRenew, "TLS_RENEWAL_NOT_ACTIVE");
    demand(renewalState.renewalState !== "failed", "TLS_RENEWAL_FAILED");
    const result = { clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, host: c.host, phase: "succeeded", protocol: "https", url: `https://${c.host}`, ...renewalState, ...(stagingCheck ? { stagingCheck } : {}), expiresAt: certificate.expiresAt, updatedAt: new Date().toISOString(), httpOnlyTest: false };
    await fs.writeFile(path.join(receiptDir, "result.json"), JSON.stringify(result), { mode: 0o600 }); return result;
  } catch (error) {
    let rollback = true;
    try {
      if (written) { await replaceConfiguration(previous); await run("nginx", ["-t"]); await run("systemctl", ["reload", "nginx"]); }
      if (firewallAdded) await run("ufw", ["delete", "allow", "443/tcp"]);
      if (timerCreated) await run("systemctl", ["disable", "--now", `${renewal.unit}.timer`]);
      for (const [file, contents] of createdUnits) { demand(await read(file) === contents, "TLS_RENEWAL_UNIT_OCCUPIED"); await fs.unlink(file); }
      if (createdUnits.length) await run("systemctl", ["daemon-reload"]);
    } catch { rollback = false; }
    const result = { clientId: c.clientId, jobId: c.jobId, releaseId: c.releaseId, host: c.host, phase: rollback ? "failed" : "needs_attention", protocol: current === nginxHttpsConfiguration(c) ? "https" : "http", errorCode: /^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "HTTPS_SETUP_FAILED", failedStep: stage, updatedAt: new Date().toISOString(), rollback };
    await fs.writeFile(path.join(receiptDir, "result.json"), JSON.stringify(result), { mode: 0o600 }); return result;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
module.exports = { validatePublication, nginxConfiguration, publishIp, checkIpPublication, localHttpResponse, tlsPaths, nginxHttpsConfiguration, httpsHealth, inspectIpCertificate, renewalConfiguration, renewalStatus, enableIpHttps, checkAcmeDirectory };
