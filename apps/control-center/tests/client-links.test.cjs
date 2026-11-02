const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = createRequire(path.resolve(__dirname, "../package.json"))("typescript");
const moduleExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../deploy-panel/app/client-links.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: moduleExports, URL });
const { buildLiveSiteUrl } = moduleExports;

test("client link: a Linux installation directory is never appended to a website URL", () => {
  assert.equal(buildLiveSiteUrl({ hostUrl: "https://client.example", deployPath: "/srv/lms-core/clients/client" }), "https://client.example/");
});
test("client link: explicit website subpath, port, query and fragment are preserved", () => {
  assert.equal(buildLiveSiteUrl({ hostUrl: "https://client.example:8443/lms/?view=home#top", deployPath: "/var/www/app" }), "https://client.example:8443/lms/?view=home#top");
});
test("client link: Windows filesystem paths are not web paths either", () => {
  assert.equal(buildLiveSiteUrl({ hostUrl: "http://127.0.0.1:3100", deployPath: "C:\\fixture\\client" }), "http://127.0.0.1:3100/");
});
test("client link: missing, relative, malformed and non-HTTP addresses are absent", () => {
  for (const value of [null, undefined, {}, { hostUrl: "" }, { hostUrl: "/srv/client" }, { hostUrl: "not a URL" }, { hostUrl: "ftp://client.example" }, { hostUrl: "javascript:alert(1)" }]) assert.equal(buildLiveSiteUrl(value), null);
});
test("client link: embedded credentials must not become a public link", () => {
  assert.equal(buildLiveSiteUrl({ hostUrl: "https://fixture-user:fixture-password@client.example" }), null);
  assert.equal(buildLiveSiteUrl({ hostUrl: "https://fixture-user@client.example" }), null);
});
test("client link: ordinary whitespace and IPv6 local URLs normalize safely", () => {
  assert.equal(buildLiveSiteUrl({ hostUrl: "  http://[::1]:3100/lms  " }), "http://[::1]:3100/lms");
});
