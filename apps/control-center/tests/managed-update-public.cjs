"use strict";
const assert = require("node:assert/strict");
async function main() {
  const origin = new URL(process.argv[2]), clientId = process.argv[3];
  assert.equal(origin.protocol, "https:"); assert.equal(origin.username + origin.password, ""); assert.match(clientId, /^[a-f0-9-]{36}$/i);
  const options = { redirect: "error", signal: AbortSignal.timeout(15000) };
  const response = await fetch(origin.origin, options), html = await response.text(); assert.equal(response.status, 200);
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"<>]+\.(?:js|css)(?:\?[^"<>]*)?)"/g)].map(match => match[1]))];
  const selected = [assets.find(asset => /\.js(?:\?|$)/.test(asset)), assets.find(asset => /\.css(?:\?|$)/.test(asset))];
  for (const asset of selected) { assert.ok(asset && !asset.includes("..")); const result = await fetch(origin.origin + asset, { redirect: "error", signal: AbortSignal.timeout(15000) }); assert.equal(result.status, 200); assert.ok(!/text\/html/i.test(result.headers.get("content-type") || "")); await result.body?.cancel(); }
  const health = await (await fetch(origin.origin + "/api/core-runtime/health", { redirect: "error", signal: AbortSignal.timeout(15000) })).json();
  assert.equal(health.clientId, clientId); assert.equal(health.protocol, "lms-core-client-v1"); assert.equal(health.status, "ok"); assert.equal(health.storage, "postgresql-runtime");
  process.stdout.write(JSON.stringify({ publicHttps: true, page: 200, javascript: 200, css: 200, clientConfirmed: true, postgresHealth: true, checkedAt: new Date().toISOString() }) + "\n");
}
main().catch(error => { process.stderr.write("Public LMS verification failed: " + error.message + "\n"); process.exitCode = 1; });
