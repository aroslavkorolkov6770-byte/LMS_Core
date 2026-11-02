"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const exec = require("node:util").promisify(require("node:child_process").execFile);
const { configureMail, inspectMail, testMail } = require("../scripts/configure-lms-mail.cjs");
const { configureAi } = require("../scripts/configure-lms-ai.cjs");
const { runFixture } = require("./ai-linux-acceptance.cjs");

async function smtpFixture(credentials, expected, implicitTls) {
  const context = tls.createSecureContext(credentials), sockets = new Set(), accepted = [];
  let wrongPassword = false;
  function session(socket, encrypted, greeting) {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = "", data = false, authenticated = false, recipient = "";
    if (greeting) socket.write("220 fixture.local ESMTP\r\n");
    const onData = chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) { if (line === ".") { data = false; accepted.push({ recipient, encrypted, authenticated }); socket.write("250 2.0.0 Accepted\r\n"); } continue; }
        if (/^(EHLO|HELO) /i.test(line)) socket.write(encrypted ? "250-fixture.local\r\n250 AUTH PLAIN\r\n" : "250-fixture.local\r\n250 STARTTLS\r\n");
        else if (/^STARTTLS$/i.test(line) && !encrypted) {
          socket.write("220 Begin TLS\r\n"); socket.removeListener("data", onData);
          const protectedSocket = new tls.TLSSocket(socket, { isServer: true, secureContext: context }); session(protectedSocket, true, false); return;
        } else if (/^AUTH PLAIN /i.test(line) && encrypted) {
          const fields = Buffer.from(line.slice(11), "base64").toString("utf8").split("\0");
          authenticated = !wrongPassword && fields.at(-2) === expected.SMTP_USER && fields.at(-1) === expected.SMTP_PASS;
          socket.write(authenticated ? "235 2.7.0 Authenticated\r\n" : "535 5.7.8 Authentication failed\r\n");
        } else if (/^MAIL FROM:/i.test(line) && authenticated) socket.write("250 2.1.0 Sender accepted\r\n");
        else if (/^RCPT TO:/i.test(line) && authenticated) { recipient = line.slice(8).trim().replace(/^<|>$/g, ""); socket.write("250 2.1.5 Recipient accepted\r\n"); }
        else if (/^DATA$/i.test(line) && authenticated && recipient) { data = true; socket.write("354 End with dot\r\n"); }
        else if (/^QUIT$/i.test(line)) { socket.end("221 Bye\r\n"); }
        else if (/^(RSET|NOOP)$/i.test(line)) socket.write("250 OK\r\n");
        else socket.write("530 Authentication required\r\n");
      }
    };
    socket.on("data", onData);
  }
  const server = implicitTls ? tls.createServer(credentials, socket => session(socket, true, true)) : net.createServer(socket => session(socket, false, true));
  server.on("tlsClientError", () => {});
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, accepted, rejectPassword() { wrongPassword = true; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

runFixture(async f => {
  const mailerSource = path.resolve(__dirname, "../../node_modules/.pnpm/nodemailer@8.0.11/node_modules/nodemailer");
  await fs.cp(mailerSource, path.join(f.app, "node_modules/nodemailer"), { recursive: true });
  await fs.mkdir(path.join(f.app, "app/api/send-email"), { recursive: true });
  await fs.writeFile(path.join(f.app, "app/api/send-email/route.ts"), "SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS nodemailer createTransport sendMail process.env.SMTP_USER");
  const keyPath = path.join(f.root, "smtp-fixture.key"), certPath = path.join(f.root, "smtp-fixture.crt");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "1"], { timeout: 30000, maxBuffer: 65536 });
  const cert = await fs.readFile(certPath, "utf8"), key = await fs.readFile(keyPath, "utf8");
  const expected = { SMTP_USER: "sender@example.invalid", SMTP_PASS: "fixture $smtp# 'password\\n" };
  const secure = await smtpFixture({ cert, key }, expected, true), startTls = await smtpFixture({ cert, key }, expected, false);
  const opts = { run: f.run, testTls: { ca: cert, servername: "localhost" } }, target = () => ({ ...f.c, operationId: crypto.randomUUID() });
  try {
    const values = { ...expected, SMTP_HOST: "127.0.0.1", SMTP_PORT: String(secure.port), SMTP_SECURE: "true" };
    const first = await configureMail(target(), values, opts);
    if (first.phase !== "applied") {
      const journal = (await exec("journalctl", ["-u", f.unit, "-n", "25", "--no-pager"], { timeout: 10000, maxBuffer: 65536 })).stdout;
      throw Error(JSON.stringify(first) + "\n" + journal.replaceAll(expected.SMTP_PASS, "<fixture-secret>"));
    }
    assert.deepEqual(await f.probe(), { tokenVersion: 2, unrelatedPreserved: true });
    const before = await fs.readFile(path.join(f.shared, "ai.env"), "utf8");
    const read = await inspectMail(f.c, opts); assert.equal(read.passwordPresent, true); assert.equal(read.smtpVerified, false); assert.equal(secure.accepted.length, 0);
    const tlsSent = await testMail(f.c, "target@example.invalid", opts); assert.equal(tlsSent.phase, "test_sent", JSON.stringify(tlsSent)); assert.equal(tlsSent.smtpVerified, true);
    assert.deepEqual(secure.accepted, [{ recipient: "target@example.invalid", encrypted: true, authenticated: true }]);
    assert.equal(JSON.stringify(tlsSent).includes(expected.SMTP_PASS), false);
    const badCertificate = await testMail(f.c, "target@example.invalid", { run: f.run }); assert.equal(badCertificate.phase, "test_failed"); assert.equal(secure.accepted.length, 1);
    secure.rejectPassword(); const rejected = await testMail(f.c, "target@example.invalid", opts); assert.equal(rejected.phase, "test_failed"); assert.equal(rejected.errorCode, "MAIL_AUTH_FAILED");
    assert.equal(await fs.readFile(path.join(f.shared, "ai.env"), "utf8"), before);
    assert.equal((await configureAi(target(), { ...f.ids, AI_API_KEY: "fixture-ai-v2" }, { run: f.run })).phase, "applied");
    assert.equal((await inspectMail(f.c, opts)).SMTP_USER, expected.SMTP_USER);
    const next = { ...values, SMTP_PORT: String(startTls.port), SMTP_SECURE: "false", SMTP_PASS: "" };
    assert.equal((await configureMail(target(), next, opts)).phase, "applied");
    const started = await testMail(f.c, "target@example.invalid", opts); assert.equal(started.phase, "test_sent", JSON.stringify(started));
    assert.deepEqual(startTls.accepted, [{ recipient: "target@example.invalid", encrypted: true, authenticated: true }]);
    let failedOnce = false;
    const rollback = await configureMail(target(), { ...values, SMTP_HOST: "rollback.example.invalid" }, { run: async (file, args) => { if (!failedOnce && args[0] === "restart") { failedOnce = true; throw Error("Fixture failure"); } return f.run(file, args); } });
    assert.equal(rollback.phase, "failed"); assert.equal(rollback.rollbackRestored, true); assert.equal((await inspectMail(f.c, opts)).SMTP_HOST, "127.0.0.1");
    assert.deepEqual(await f.probe(), { tokenVersion: 2, unrelatedPreserved: true });
    const stat = await fs.stat(path.join(f.shared, "ai.env")); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, 0o640);
    console.log(JSON.stringify({ localSmtpTls: true, startTls: true, onlyLoopback: true, realNodemailer: true, sentAsServiceUser: true, badCertificateRefused: true, authFailureSafe: true,
      readDoesNotSend: true, exactlyOneMessagePerAction: true, aiAndMailPreserved: true, mailRollback: true, externalEmailMessages: 0 }));
  } finally { await secure.close(); await startTls.close(); }
}).catch(error => { console.error(error.stack || error.code || error.message); process.exitCode = 1; });
