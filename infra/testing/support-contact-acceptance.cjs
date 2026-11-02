"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "../..");
const toLinux = file => "/mnt/" + file[0].toLowerCase() + file.slice(2).replaceAll("\\", "/");

(async () => {
  const output = path.join(root, "infra/runtime/local-acceptance/support-contact-20261030", randomUUID());
  await fs.mkdir(output, { recursive: true }); console.log("Support acceptance: " + output);
  const source = path.join(root, "infra/runtime/source-cache/f0140c68-d136-4fe2-aa40-80d9ae2e5185/source");
  const { prepareSupportPatch } = require("../../apps/control-center/dist/support-contact-adapter.js");
  await fs.writeFile(path.join(output, "patch.json"), JSON.stringify(await prepareSupportPatch(root, source)));
  const child = spawn("wsl.exe", ["-d", "LMS-Core-Clean-Test", "-u", "root", "--", "node", toLinux(path.join(root, "infra/testing/support-contact-linux.cjs")), toLinux(output), toLinux(source)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "", exited = false, exitCode;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += chunk; });
  const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => { exited = true; exitCode = code; resolve(code); }); });
  async function stage(phase) {
    for (let attempt = 0; attempt < 1800; attempt++) {
      if (exited && exitCode !== 0) throw Error("Local Linux failed: " + log.slice(-2500));
      try { const value = JSON.parse(await fs.readFile(path.join(output, "stage.json"), "utf8")); if (value.phase === phase) return value; } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error("CONTACT_STAGE_TIMEOUT_" + phase);
  }
  let browser;
  try {
    const first = await stage("first"); console.log("One-time Linux Next build accepted; checking actual rendered pages");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CORE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(first.url, { waitUntil: "networkidle" });
    await page.locator('[data-core-support-contact="v1"]').filter({ hasText: first.email }).waitFor();
    assert.equal(await page.locator('[data-core-support-contact="v1"]').getAttribute("href"), "mailto:" + first.email);
    await page.goto(first.url + "/privacy?doc=privacy#privacy", { waitUntil: "networkidle" });
    await page.locator('a[href="mailto:first@example.invalid"]').first().waitFor();
    assert.ok(await page.locator('a[href="mailto:first@example.invalid"]').count() >= 2);
    assert.equal(await page.getByText(/teacoffe?e?@yandex\.ru/).count(), 0);
    await page.screenshot({ path: path.join(output, "support-first.png"), fullPage: false });
    await fs.writeFile(path.join(output, "rotate"), "rotate");
    const second = await stage("second");
    // Keep the document open: focus refresh must update both legal text and footer without navigation.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(email => [...document.querySelectorAll('[data-core-support-contact="v1"]')].every(link => link.getAttribute("href") === "mailto:" + email), second.email, { timeout: 70000 });
    assert.equal(await page.locator('a[href="mailto:first@example.invalid"]').count(), 0);
    assert.ok(await page.locator('a[href="mailto:second@example.invalid"]').count() >= 2);
    const publicState = await page.evaluate(async () => (await fetch("/api/core-runtime/support-contact")).json());
    assert.deepEqual(publicState, { protocol: "lms-core-support-contact-v1", supportEmail: second.email });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, "support-second.png"), fullPage: false });
    await fs.writeFile(path.join(output, "finish"), "finish");
    assert.equal(await completion, 0, log);
    const linux = JSON.parse(await fs.readFile(path.join(output, "linux-contact-receipt.json"), "utf8"));
    const receipt = { checkedAt: new Date().toISOString(), linux, actualFooterAndPrivacy: true, livePageEmailRotation: true, noBrowserErrors: true, externalSshOrProviderRequests: false, output };
    await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
  } finally {
    await browser?.close();
    await fs.writeFile(path.join(output, "linux-contact.log"), log);
    // Let the Linux fixture reach its own protected cleanup even when a browser assertion fails.
    if (!exited) { await fs.writeFile(path.join(output, "rotate"), "cleanup"); await fs.writeFile(path.join(output, "finish"), "cleanup"); await completion; }
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
