const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { validatePublication, nginxConfiguration, publishIp, localHttpResponse } = require("../../../infra/scripts/publish-lms-ip.cjs");

async function fixture(t, override = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-ip-publication-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-ip-publication-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const config = { clientId: randomUUID(), jobId: randomUUID(), releaseId: randomUUID(), host: "192.0.2.50", webPort: 3000, appPath: "/srv/lms-core/clients/fixture" };
  const disk = (file) => path.join(root, file);
  await fs.mkdir(disk(config.appPath), { recursive: true });
  await fs.writeFile(disk(config.appPath + "/.core-install-owner.json"), JSON.stringify({ ...config, state: "installed" }));
  await fs.mkdir(disk("/etc/nginx/conf.d"), { recursive: true });
  await fs.writeFile(disk("/etc/nginx/nginx.conf"), "http { include /etc/nginx/conf.d/*.conf; }");
  const calls = [], requests = [];
  const options = { root, fixture: true, run: async (file, args) => {
    calls.push([file, ...args]);
    const value = await override.run?.(file, args, calls);
    if (value !== undefined) return value;
    if (file === "ufw") throw Object.assign(Error("not installed"), { code: "ENOENT" });
    if (file === "nginx" && args[0] === "-T") return "# configuration file /etc/nginx/nginx.conf:\nhttp{}\n";
    return "";
  }, fetch: async (url, init) => {
    requests.push({ url, headers: init?.headers });
    const value = await override.fetch?.(url, init);
    if (value !== undefined) return value;
    return { ok: true, json: async () => ({ protocol: "lms-core-client-v1", status: "ok", clientId: config.clientId, releaseId: config.releaseId, ...override.health }) };
  } };
  const file = disk(`/etc/nginx/conf.d/lms-core-${config.clientId}.conf`);
  return { root, disk, config, options, calls, requests, file };
}

test("IP input rejects DNS, injection, foreign paths and non-runtime ports", () => {
  const valid = { clientId: randomUUID(), jobId: randomUUID(), releaseId: randomUUID(), host: "192.0.2.50", webPort: 3000, appPath: "/srv/lms-core/clients/fixture" };
  assert.deepEqual(validatePublication(valid), valid);
  for (const value of [{ host: "example.org" }, { host: "192.0.2.50; include /secret" }, { webPort: 5432 }, { appPath: "/etc/nginx" }, { appPath: "/srv/lms-core/clients/../other" }, { clientId: "bad" }]) assert.throws(() => validatePublication({ ...valid, ...value }));
  const conf = nginxConfiguration(valid), suffix = valid.clientId.replaceAll("-", "");
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.ok(conf.includes("default $http_origin;"));
  assert.ok(conf.includes("proxy_hide_header Content-Security-Policy;"));
  assert.ok(conf.includes("default $upstream_http_content_security_policy;"));
  assert.ok(conf.includes(`proxy_cookie_flags core_lms_session_${suffix} nosecure httponly samesite=lax;`));
  assert.equal(conf.includes("listen 4101"), false);
  assert.equal(conf.includes("listen 5432"), false);
});

test("IP publication creates one owned proxy, verifies identity and is idempotent", async (t) => {
  const f = await fixture(t), first = await publishIp(f.config, f.options);
  assert.equal(first.phase, "succeeded"); assert.equal(first.url, "http://192.0.2.50");
  assert.equal(await fs.readFile(f.file, "utf8"), nginxConfiguration(f.config));
  assert.equal(f.requests[1].headers.Host, f.config.host);
  assert.equal(f.calls.some(([file, ...args]) => /postgres|mysql/.test(file + args.join(" "))), false);
  assert.equal(f.calls.some(([file, ...args]) => file === "systemctl" && args.some((value) => /lms-.*\.service/.test(value))), false);
  assert.equal((await publishIp(f.config, f.options)).phase, "succeeded");
});

test("a foreign file or existing exact-IP server is never overwritten", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, "# another owner\n");
  assert.equal((await publishIp(f.config, f.options)).errorCode, "NGINX_CONFIG_OCCUPIED");
  assert.equal(await fs.readFile(f.file, "utf8"), "# another owner\n");
  const other = await fixture(t, { run: async (file, args) => file === "nginx" && args[0] === "-T" ? "# configuration file /etc/nginx/conf.d/other.conf:\nserver { server_name 192.0.2.50; }" : undefined });
  assert.equal((await publishIp(other.config, other.options)).errorCode, "NGINX_IP_ALREADY_CONFIGURED");
  await assert.rejects(fs.stat(other.file), { code: "ENOENT" });
});

test("failed nginx syntax removes only the just-created config, preserving other sites", async (t) => {
  let failed = false;
  const f = await fixture(t, { run: async (file, args) => { if (file === "nginx" && args[0] === "-t" && !failed) { failed = true; throw Error("syntax fixture secret"); } } });
  const foreign = f.disk("/etc/nginx/conf.d/unrelated.conf"); await fs.writeFile(foreign, "unrelated site");
  const result = await publishIp(f.config, f.options);
  assert.equal(result.phase, "failed"); assert.equal(result.rollback, true);
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
  assert.equal(await fs.readFile(foreign, "utf8"), "unrelated site");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("a replaced own configuration is restored if activation fails", async (t) => {
  let failed = false;
  const f = await fixture(t, { run: async (file, args) => { if (file === "systemctl" && args[0] === "enable" && !failed) { failed = true; throw Error("activation fixture"); } } });
  const previous = `# LMS Core HTTP test client:${f.config.clientId}\n# previous own version\n`;
  await fs.writeFile(f.file, previous);
  assert.equal((await publishIp(f.config, f.options)).phase, "failed");
  assert.equal(await fs.readFile(f.file, "utf8"), previous);
});

test("foreign process on port80 and an incomplete install prevent configuration", async (t) => {
  const f = await fixture(t, { run: async (file) => file === "ss" ? 'LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("apache2",pid=8,fd=3))' : undefined });
  assert.equal((await publishIp(f.config, f.options)).errorCode, "HTTP_PORT_OCCUPIED");
  assert.equal(f.calls.some(([file]) => file === "apt-get"), false);
  await fs.writeFile(f.disk(f.config.appPath + "/.core-install-owner.json"), JSON.stringify({ ...f.config, state: "installing" }));
  await assert.rejects(publishIp(f.config, f.options), { code: "PUBLICATION_OWNER_MISMATCH" });
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});

test("only port80 is added to active UFW; foreign rules remain untouched", async (t) => {
  const f = await fixture(t, { run: async (file, args) => file === "ufw" ? args[0] === "status" ? "Status: active\n" : args[0] === "show" ? "ufw allow 22/tcp\n" : "" : undefined });
  assert.equal((await publishIp(f.config, f.options)).phase, "succeeded");
  assert.deepEqual(f.calls.filter(([file]) => file === "ufw"), [["ufw", "status"], ["ufw", "show", "added"], ["ufw", "allow", "80/tcp"]]);
});

test("runtime identity mismatch fails before nginx or firewall commands", async (t) => {
  const f = await fixture(t, { health: { releaseId: randomUUID() } });
  await assert.rejects(publishIp(f.config, f.options), { code: "PUBLICATION_HEALTH_FAILED" });
  assert.equal(f.calls.length, 0);
});

test("new nginx workers are given time to accept traffic after reload", async (t) => {
  let firstPublic = true;
  const f = await fixture(t, { fetch: async (url) => { if (url.startsWith("http://127.0.0.1/" ) && firstPublic) { firstPublic = false; throw SyntaxError("Previous default worker returned HTML"); } } });
  assert.equal((await publishIp(f.config, f.options)).phase, "succeeded");
  assert.equal(firstPublic, false);
  assert.equal(f.requests.length, 3);
});

test("loopback health uses the exact Host header rather than Node fetch defaults", async (t) => {
  const server = require("node:http").createServer((request, response) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ host: request.headers.host })); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await localHttpResponse(`http://127.0.0.1:${server.address().port}`, { headers: { Host: "192.0.2.50" } });
  assert.equal((await response.json()).host, "192.0.2.50");
  assert.throws(() => localHttpResponse("http://foreign.invalid"), { code: "PUBLICATION_HEALTH_URL_INVALID" });
});
