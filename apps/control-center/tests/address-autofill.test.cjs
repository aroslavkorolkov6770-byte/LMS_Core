const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../deploy-panel/app/address-autofill.ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: exportsObject, URL });
const { fillClientAddresses, extractClientIp } = exportsObject;
test("one explicit IP fills all empty card addresses", () => {
  for (const input of [{ domain: "192.0.2.15", hostUrl: "", databaseHost: "" }, { domain: "", hostUrl: "https://192.0.2.15/", databaseHost: "" }, { domain: "", hostUrl: "", databaseHost: "192.0.2.15" }]) {
    const result = fillClientAddresses(input); assert.equal(result.domain, "192.0.2.15"); assert.equal(result.databaseHost, "192.0.2.15"); assert.ok(result.hostUrl.includes("192.0.2.15")); assert.notEqual(result, input);
  }
});
test("explicit separate DB host and website domain are never overwritten", () => {
  const value = { domain: "lms.example.test", hostUrl: "https://192.0.2.15", databaseHost: "192.0.2.20" };
  assert.equal(JSON.stringify(fillClientAddresses(value)), JSON.stringify(value));
});
test("credentials, paths, malformed IPv4, shorthand and octal cannot autofill a server", () => {
  for (const value of ["http://name:secret@192.0.2.15", "http://192.0.2.15/path", "https://192.0.2.15?q=1", "999.0.0.1", "1234", "127.1", "0127.0.0.1", "example.test"]) assert.equal(extractClientIp(value), "");
});
