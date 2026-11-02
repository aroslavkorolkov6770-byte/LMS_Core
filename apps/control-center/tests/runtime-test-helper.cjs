const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "../../..");
const apiRequire = createRequire(path.join(root, "apps/api/package.json"));
const dbRequire = createRequire(path.join(root, "packages/db/package.json"));

// Only our adapter template is evaluated. Downloaded project scripts are not executed.
function loadAdapter() {
  const ts = apiRequire("typescript");
  const source = fs.readFileSync(path.join(root, "infra/lms-adapter/core-runtime-data-store.ts"), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  vm.runInNewContext(output.outputText, { exports, require: (name) => {
    if (name === "server-only") return {};
    throw new Error("Unexpected adapter import");
  }, Buffer, URL, AbortSignal, structuredClone, fetch, process: { env: {} } });
  return exports;
}

module.exports = { root, apiRequire, dbRequire, loadAdapter };
