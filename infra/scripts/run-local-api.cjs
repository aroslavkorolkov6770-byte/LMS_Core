"use strict";
const path = require("node:path");
const { ensureLocalApiBuild } = require("./local-api-build.cjs");

try {
  const root = path.resolve(__dirname, "../..");
  const directory = path.join(root, "apps/api");
  const prepared = ensureLocalApiBuild(root);
  if (prepared.rebuilt) process.stdout.write("Локальная сборка API подготовлена и проверена.\n");
  // Match `pnpm --dir apps/api start`, including dotenv/relative-file behavior.
  process.chdir(directory);
  require(path.join(directory, "dist/main.js"));
} catch (error) {
  const code = /^LOCAL_(?:API_BUILD_[A-Z_]+(?::[a-z/]+)?|BUILD_SYMLINK_REFUSED)$/.test(error.message || "") ? error.message : "CONFIGURATION_OR_RUNTIME_ERROR";
  process.stderr.write("LOCAL_API_START_FAILED: " + code + "\n");
  process.exitCode = 1;
}
