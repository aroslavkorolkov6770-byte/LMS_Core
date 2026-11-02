const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { publishIp, checkIpPublication, localHttpResponse } = require("../../scripts/publish-lms-ip.cjs");
const exec = promisify(execFile);

(async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const clientId = randomUUID(), jobId = randomUUID(), releaseId = randomUUID();
  const appPath = "/srv/lms-core/clients/ip-acceptance-" + clientId.slice(0, 8);
  const configFile = `/etc/nginx/conf.d/lms-core-${clientId}.conf`;
  const publicationPath = `/srv/lms-core/publications/${clientId}`;
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests");
    response.setHeader("Strict-Transport-Security", "max-age=63072000");
    if (request.url === "/api/core-runtime/health") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ protocol: "lms-core-client-v1", status: "ok", clientId, releaseId })); }
    else if (request.method === "POST") {
      if (request.headers.origin !== `http://127.0.0.1:${server.address().port}`) { response.writeHead(403); response.end("origin rejected"); return; }
      response.setHeader("Set-Cookie", `core_lms_session_${clientId.replaceAll("-", "")}=fixture-only; Path=/; Secure; HttpOnly; SameSite=Lax`);
      response.end("accepted");
    } else { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Local proxy fixture</title>Local proxy fixture"); }
  });
  await fs.mkdir("/srv/lms-core/clients", { recursive: true });
  await fs.mkdir(appPath, { mode: 0o750 });
  await fs.writeFile(path.join(appPath, ".core-install-owner.json"), JSON.stringify({ clientId, jobId, releaseId, state: "installed" }), { flag: "wx", mode: 0o600 });
  try {
    let port = 0;
    for (let candidate = 3050; candidate < 3099; candidate++) {
      try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(candidate, "127.0.0.1", resolve); }); port = candidate; break; }
      catch (error) { if (error.code !== "EADDRINUSE") throw error; }
    }
    assert.ok(port);
    const config = { clientId, jobId, releaseId, host: "127.0.0.1", appPath, webPort: port };
    const result = await publishIp(config);
    assert.equal(result.phase, "succeeded", JSON.stringify(result));
    assert.equal((await checkIpPublication(config)).phase, "succeeded");
    const page = await fetch("http://127.0.0.1"); assert.equal(page.status, 200); assert.match(await page.text(), /Local proxy fixture/);
    assert.match(page.headers.get("x-robots-tag"), /noindex/);
    assert.equal(page.headers.get("content-security-policy"), "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
    assert.equal(page.headers.get("strict-transport-security"), null);
    const login = await fetch("http://127.0.0.1/api/auth", { method: "POST", headers: { Origin: "http://127.0.0.1", "Sec-Fetch-Site": "same-origin" }, body: "fixture" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie"); assert.ok(cookie); assert.equal(/;\s*Secure(?:;|$)/i.test(cookie), false); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
    assert.equal((await fetch("http://127.0.0.1/api/auth", { method: "POST", headers: { Origin: "http://foreign.invalid" } })).status, 403);
    const foreign = await localHttpResponse("http://127.0.0.1", { headers: { Host: "foreign.invalid" } });
    assert.equal((await foreign.text()).includes("Local proxy fixture"), false);
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), realLinuxNginx: true, publicPage: true, runtimeIdentity: true, httpTestCookie: true, sameOrigin: true, foreignOriginRejected: true, foreignHostDoesNotReachLms: true, externalVpsChanged: false }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      const own = await fs.readFile(configFile, "utf8");
      assert.ok(own.startsWith(`# LMS Core HTTP test client:${clientId}\n`));
      await fs.unlink(configFile); await exec("nginx", ["-t"]); await exec("systemctl", ["reload", "nginx"]);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const owner = JSON.parse(await fs.readFile(path.join(appPath, ".core-install-owner.json"), "utf8"));
    assert.equal(owner.jobId, jobId); assert.equal(path.dirname(appPath), "/srv/lms-core/clients");
    await fs.rm(appPath, { recursive: true });
    assert.equal(path.dirname(publicationPath), "/srv/lms-core/publications"); assert.ok(publicationPath.endsWith(clientId));
    await fs.rm(publicationPath, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
