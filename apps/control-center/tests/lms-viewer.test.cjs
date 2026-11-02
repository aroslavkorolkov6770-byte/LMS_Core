const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { Duplex } = require("node:stream");
const { randomUUID } = require("node:crypto");
const { createLmsGateway, LmsViewerService } = require("../dist/lms-viewer.js");

async function fixture(t) {
  const state = { clientId: randomUUID(), releaseId: randomUUID(), webPort: 0 };
  let calls = 0;
  const name = "core_lms_session_" + state.clientId.replaceAll("-", "");
  const server = http.createServer((req, res) => {
    calls++;
    if (req.url === "/api/core-runtime/health") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ protocol: "lms-core-client-v1", clientId: state.clientId, releaseId: state.releaseId, storage: "postgresql-runtime" })); return; }
    if (req.url === "/external") { res.writeHead(302, { Location: "https://external.invalid/" }); res.end(); return; }
    if (req.url === "/redirect") { res.writeHead(302, { Location: `http://127.0.0.1:${state.webPort}/login` }); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json", "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'", "X-Frame-Options": "DENY", "Set-Cookie": [`${name}=fixture; HttpOnly; SameSite=Lax; Path=/; Domain=127.0.0.1`, "other_client=do-not-forward"] });
    res.end(JSON.stringify({ cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host, forwarded: req.headers["x-forwarded-host"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); state.webPort = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const ports = [];
  const open = async (port) => { ports.push(port); const socket = net.createConnection({ host: "127.0.0.1", port }); return Duplex.from({ readable: socket, writable: socket }); };
  return { state, open, ports, name, calls: () => calls };
}
function request(url, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method }, (res) => { let text = ""; res.on("data", (data) => { text += data; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text })); });
    req.on("error", reject); req.end();
  });
}

test("private gateway maps Origin/Host and isolates client cookies without removing CSP or frame protections", async (t) => {
  const f = await fixture(t), gate = await createLmsGateway(f.state, f.open); t.after(() => gate.close());
  const result = await request(gate.url + "/echo", { Origin: gate.url, Cookie: `another_client=secret; ${f.name}=own-cookie`, "X-Forwarded-Host": "attacker.invalid" }, "POST");
  assert.equal(result.status, 200);
  const data = JSON.parse(result.text);
  assert.equal(data.origin, `http://127.0.0.1:${f.state.webPort}`); assert.equal(data.host, `127.0.0.1:${f.state.webPort}`);
  assert.equal(data.cookie.trim(), `${f.name}=own-cookie`); assert.equal(data.forwarded, undefined);
  assert.equal(result.headers["x-frame-options"], "DENY"); assert.ok(result.headers["content-security-policy"].includes("frame-ancestors"));
  assert.equal(result.headers["set-cookie"].length, 1); assert.ok(!result.headers["set-cookie"][0].includes("Domain="));
  assert.deepEqual(f.ports, [f.state.webPort]);
});

test("gateway rejects foreign Host/Origin, cross-site and headerless mutations before forwarding", async (t) => {
  const f = await fixture(t), gate = await createLmsGateway(f.state, f.open); t.after(() => gate.close());
  assert.equal((await request(gate.url, { Host: "evil.invalid" })).status, 421);
  assert.equal((await request(gate.url, { Origin: "https://evil.invalid" })).status, 403);
  assert.equal((await request(gate.url, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await request(gate.url, {}, "POST")).status, 403);
  assert.equal(f.calls(), 0);
});

test("gateway rewrites only same-LMS redirects and closes its localhost listener", async (t) => {
  const f = await fixture(t), gate = await createLmsGateway(f.state, f.open);
  assert.equal((await request(gate.url + "/redirect")).headers.location, gate.url + "/login");
  assert.equal((await request(gate.url + "/external")).status, 502);
  await gate.close(); await assert.rejects(request(gate.url));
});

test("viewer binds saved client/release/SSH identity, is independent of deployment locks and closes on demand", async (t) => {
  const f = await fixture(t);
  const target = { host: "127.0.0.1", port: 22823, username: "root", fingerprint: "SHA256:" + "A".repeat(43), basePath: "/srv/lms-core/clients" };
  let connections = 0;
  const remote = { withSession: async (selected, auth, operation, independent) => { assert.equal(selected.fingerprint, target.fingerprint); assert.equal(independent, true); connections++; return operation({ openLoopback: f.open }); } };
  const service = new LmsViewerService(remote, { get: async () => ({ ...f.state, target, phase: "succeeded" }) });
  const auth = { mode: "password", password: "fixture-only" };
  await assert.rejects(service.open(f.state.clientId, { ...target, fingerprint: "SHA256:" + "B".repeat(43) }, auth)); assert.equal(connections, 0); assert.equal(auth.password, undefined);
  const opened = await service.open(f.state.clientId, target, { mode: "password" });
  assert.equal(opened.phase, "open"); assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await request(opened.url)).status, 200);
  await service.close(); assert.equal(service.get().phase, "closed"); await assert.rejects(request(opened.url));
});
