"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const exec = require("node:util").promisify(require("node:child_process").execFile);
const worker = require("../../../infra/scripts/publish-lms-ip.cjs");

async function fixture(t) {
  assert.equal(process.platform, "linux");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-ip-https-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("core-ip-https-")); await fs.rm(root, { recursive: true, force: true }); });
  const c = { clientId: randomUUID(), jobId: randomUUID(), releaseId: randomUUID(), host: "192.0.2.70", appPath: "/srv/lms-core/clients/test", webPort: 3000, acmeAgreement: true };
  const p = worker.tlsPaths(c), disk = name => path.join(root, name), config = disk(`/etc/nginx/conf.d/lms-core-${c.clientId}.conf`), calls = [];
  for (const name of [c.appPath, "/etc/nginx/conf.d", "/etc/systemd/system", `/srv/lms-core/publications/${c.clientId}`]) await fs.mkdir(disk(name), { recursive: true });
  await fs.writeFile(disk(c.appPath + "/.core-install-owner.json"), JSON.stringify({ ...c, state: "installed" }), { mode: 0o600 });
  const original = worker.nginxConfiguration(c); await fs.writeFile(config, original);
  const mode = { failIssue: false, failHealth: false, failedRenewal: false, active: true, foreignEdit: false, ufwActive: false, disableTimerAfterFirewall: false, stagingUnavailable: false, productionUnavailable: false, stagingUntrusted: false };
  let serial = 0;
  async function issue(days = 7, host = c.host) {
    serial++;
    const archive = disk(`${p.config}/archive/${p.name}`), live = disk(`${p.config}/live/${p.name}`);
    await fs.mkdir(archive, { recursive: true }); await fs.mkdir(live, { recursive: true });
    const certificate = path.join(archive, `fullchain${serial}.pem`), key = path.join(archive, `privkey${serial}.pem`);
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", String(days), "-subj", "/CN=Core local fixture", "-addext", "subjectAltName=IP:" + host, "-keyout", key, "-out", certificate]);
    await fs.chmod(key, 0o600);
    for (const [name, target] of [["fullchain.pem", certificate], ["privkey.pem", key]]) { await fs.unlink(path.join(live, name)).catch(error => { if (error.code !== "ENOENT") throw error; }); await fs.symlink(target, path.join(live, name)); }
  }
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "nginx" && args[0] === "-T") return `# configuration file /etc/nginx/conf.d/lms-core-${c.clientId}.conf:\n${await fs.readFile(config, "utf8")}`;
    if (file === p.certbot) { if (mode.failIssue) throw Error("synthetic CA failure"); if (!args.includes("--dry-run")) await issue(); return ""; }
    if (file === "systemctl" && args[0] === "is-enabled") return mode.active ? "enabled\n" : "disabled\n";
    if (file === "systemctl" && args[0] === "is-active") return mode.active ? "active\n" : "inactive\n";
    if (file === "systemctl" && args[0] === "show") return mode.failedRenewal ? "Result=exit-code\nExecMainStatus=1\nExecMainStartTimestamp=Fri 2026-10-30 08:00:00 UTC\n" : "Result=success\nExecMainStatus=0\nExecMainStartTimestamp=\n";
    if (file === "ufw") {
      if (args[0] === "status") return mode.ufwActive ? "Status: active\n" : "Status: inactive\n";
      if (args[0] === "show") return "ufw allow 80/tcp\n";
      if (args[0] === "allow" && mode.disableTimerAfterFirewall) mode.active = false;
      return "";
    }
    return "";
  };
  const fetch = async url => {
    if (url.includes("/.well-known/acme-challenge/")) {
      const token = url.split("/").at(-1);
      return { ok: true, text: async () => fs.readFile(disk(`${p.webroot}/.well-known/acme-challenge/${token}`), "utf8") };
    }
    return { ok: true, json: async () => ({ protocol: "lms-core-client-v1", status: "ok", clientId: c.clientId, releaseId: c.releaseId }) };
  };
  const options = { fixture: true, root, run, fetch, attempts: 1, acmeProbe: async address => {
    if (mode.productionUnavailable && !address.includes("staging") || mode.stagingUnavailable && address.includes("staging")) return { ready: false, unavailable: true, errorCode: "ACME_CONNECTION_FAILED" };
    if (mode.stagingUntrusted && address.includes("staging")) return { ready: false, unavailable: false, errorCode: "ACME_DIRECTORY_TLS_FAILED" };
    return { ready: true };
  }, httpsHealth: async () => {
    if (mode.foreignEdit) await fs.writeFile(config, "# unexpected independent change\n");
    if (mode.failHealth) throw Error("synthetic TLS failure");
    return {};
  } };
  const receipt = async result => fs.writeFile(disk(`/srv/lms-core/publications/${c.clientId}/result.json`), JSON.stringify(result), { mode: 0o600 });
  return { root, c, p, disk, config, original, mode, issue, options, calls, receipt };
}

test("HTTPS requires explicit agreement and refuses nonpublic addresses before mutation", async t => {
  const f = await fixture(t);
  await assert.rejects(worker.enableIpHttps({ ...f.c, acmeAgreement: false }, f.options), /ACME_AGREEMENT_REQUIRED/);
  for (const host of ["127.0.0.1", "10.0.0.1", "100.64.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1"]) await assert.rejects(worker.enableIpHttps({ ...f.c, host }), /ACME_PUBLIC_IP_REQUIRED/);
  assert.equal(f.calls.length, 0); assert.equal(await fs.readFile(f.config, "utf8"), f.original);
});

test("HTTPS issues only after a readable challenge and keeps keys private and renewal server-side", async t => {
  const f = await fixture(t), result = await worker.enableIpHttps(f.c, f.options);
  assert.equal(result.phase, "succeeded", JSON.stringify(result)); assert.equal(result.protocol, "https"); assert.equal(result.autoRenew, true);
  assert.equal(await fs.readFile(f.config, "utf8"), worker.nginxHttpsConfiguration(f.c));
  const ca = f.calls.filter(call => call[0] === f.p.certbot);
  assert.equal(ca.length, 2); assert.ok(ca[0].includes("--dry-run") && ca[0].includes("shortlived") && ca[1].includes("--ip-address"));
  assert.ok(ca[0].includes("https://acme-staging-v02.api.letsencrypt.org/directory"));
  assert.equal((await fs.stat(f.disk(f.p.key))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
  const renewal = worker.renewalConfiguration(f.c);
  assert.match(renewal.files[1][1], /renew --quiet.*--deploy-hook/); assert.match(renewal.files[2][1], /OnCalendar=hourly/);
  assert.equal(f.calls.some(call => call[0] === "systemctl" && ["stop", "restart"].includes(call[1])), false);
  assert.equal((await worker.checkIpPublication(f.c, f.options)).url, result.url);
});

test("unreachable staging does not block a reachable production CA and records the rehearsal skip", async t => {
  const f = await fixture(t); f.mode.stagingUnavailable = true;
  const result = await worker.enableIpHttps(f.c, f.options);
  assert.equal(result.phase, "succeeded"); assert.equal(result.stagingCheck, "unavailable");
  const ca = f.calls.filter(call => call[0] === f.p.certbot);
  assert.equal(ca.length, 1); assert.ok(ca[0].includes("https://acme-v02.api.letsencrypt.org/directory"));
  assert.ok(!ca[0].includes("--dry-run")); assert.ok(ca[0].includes("--webroot") && ca[0].includes("--ip-address"));
});

test("production unreachability and a staging trust failure both stop issuance and retain the owned HTTP site", async t => {
  for (const flag of ["productionUnavailable", "stagingUntrusted"]) {
    const f = await fixture(t); f.mode[flag] = true;
    const result = await worker.enableIpHttps(f.c, f.options);
    assert.equal(result.phase, "failed"); assert.equal(result.failedStep, "check_acme_connectivity");
    assert.equal(result.errorCode, flag === "productionUnavailable" ? "ACME_CONNECTION_FAILED" : "ACME_DIRECTORY_TLS_FAILED");
    assert.equal(result.rollback, true); assert.equal(await fs.readFile(f.config, "utf8"), f.original);
    assert.equal(f.calls.filter(call => call[0] === f.p.certbot).length, 0);
  }
});

test("expired certificate can be renewed, rather than blocking its own repair", async t => {
  const f = await fixture(t); await f.issue(2);
  f.options.now = () => Date.now() + 3 * 86400000;
  assert.equal((await worker.inspectIpCertificate(f.c, f.options)).valid, false);
  const result = await worker.enableIpHttps(f.c, f.options);
  assert.equal(result.phase, "succeeded", JSON.stringify(result)); assert.equal((await worker.inspectIpCertificate(f.c, f.options)).valid, true);
  assert.equal(f.calls.filter(call => call[0] === f.p.certbot).length, 2);
});

test("repeat HTTPS does not issue another certificate, and checks refresh expiry and timer status", async t => {
  const f = await fixture(t); const first = await worker.enableIpHttps(f.c, f.options);
  assert.equal(first.phase, "succeeded");
  const count = f.calls.filter(call => call[0] === f.p.certbot).length;
  assert.equal((await worker.enableIpHttps(f.c, f.options)).phase, "succeeded");
  assert.equal(f.calls.filter(call => call[0] === f.p.certbot).length, count);
  await f.issue(9);
  const refreshed = await worker.checkIpPublication(f.c, f.options); assert.notEqual(refreshed.expiresAt, first.expiresAt);
  f.mode.active = false;
  const inactive = await worker.checkIpPublication(f.c, f.options); assert.equal(inactive.phase, "needs_attention"); assert.equal(inactive.protocol, "https"); assert.equal(inactive.errorCode, "TLS_RENEWAL_NOT_ACTIVE");
  f.mode.active = true; f.mode.failedRenewal = true;
  assert.equal((await worker.checkIpPublication(f.c, f.options)).errorCode, "TLS_RENEWAL_FAILED");
});

test("CA or TLS failure restores only the previous owned config; independent edits are preserved", async t => {
  const f = await fixture(t); f.mode.failIssue = true;
  const ca = await worker.enableIpHttps(f.c, f.options); assert.equal(ca.phase, "failed"); assert.equal(ca.rollback, true); assert.equal(await fs.readFile(f.config, "utf8"), f.original);
  const restored = await worker.checkIpPublication(f.c, f.options); assert.equal(restored.phase, "succeeded"); assert.equal(restored.protocol, "http"); assert.equal(restored.errorCode, undefined);
  f.mode.failIssue = false; f.mode.failHealth = true;
  const tls = await worker.enableIpHttps(f.c, f.options); assert.equal(tls.phase, "failed"); assert.equal(tls.errorCode, "TLS_HEALTH_FAILED"); assert.equal(await fs.readFile(f.config, "utf8"), f.original);
  f.mode.foreignEdit = true;
  const conflict = await worker.enableIpHttps(f.c, f.options); assert.equal(conflict.phase, "needs_attention"); assert.equal(conflict.rollback, false); assert.equal(await fs.readFile(f.config, "utf8"), "# unexpected independent change\n");
});

test("wrong SAN, unsafe certificate location, occupied hook and unreachable challenge never report success", async t => {
  const f = await fixture(t); await f.issue(7, "192.0.2.71");
  assert.equal((await worker.enableIpHttps(f.c, f.options)).errorCode, "TLS_CERTIFICATE_INVALID");
  const hook = f.disk(worker.renewalConfiguration(f.c).hook); await fs.mkdir(path.dirname(hook), { recursive: true }); await fs.writeFile(hook, "# not Core\n");
  const occupied = await worker.enableIpHttps(f.c, f.options); assert.equal(occupied.errorCode, "TLS_RENEWAL_UNIT_OCCUPIED"); assert.equal(await fs.readFile(hook, "utf8"), "# not Core\n");
  await fs.unlink(hook);
  const blocked = await worker.enableIpHttps(f.c, { ...f.options, fetch: async url => url.includes("acme-challenge") ? { ok: false, text: async () => "" } : f.options.fetch(url) });
  assert.equal(blocked.errorCode, "ACME_WEBROOT_UNREACHABLE");
  assert.equal(f.calls.filter(call => call[0] === f.p.certbot).length, 0);
  const outside = path.join(f.root, "outside-certificate.pem");
  await fs.copyFile(f.disk(f.p.certificate), outside); await fs.unlink(f.disk(f.p.certificate)); await fs.symlink(outside, f.disk(f.p.certificate));
  await assert.rejects(worker.inspectIpCertificate(f.c, f.options), /TLS_CERTIFICATE_PATH_UNSAFE/);
});

test("active UFW adds only443 and a later failure removes only the rule created by this action", async t => {
  const first = await fixture(t); first.mode.ufwActive = true;
  assert.equal((await worker.enableIpHttps(first.c, first.options)).phase, "succeeded");
  assert.deepEqual(first.calls.filter(call => call[0] === "ufw" && call[1] === "allow"), [["ufw", "allow", "443/tcp"]]);
  const failed = await fixture(t); failed.mode.ufwActive = true; failed.mode.disableTimerAfterFirewall = true;
  const result = await worker.enableIpHttps(failed.c, failed.options);
  assert.equal(result.phase, "failed"); assert.equal(result.rollback, true); assert.equal(await fs.readFile(failed.config, "utf8"), failed.original);
  assert.deepEqual(failed.calls.filter(call => call[0] === "ufw" && call[1] === "delete"), [["ufw", "delete", "allow", "443/tcp"]]);
});
