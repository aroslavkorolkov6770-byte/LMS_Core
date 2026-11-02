import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertRestrictedDatabaseRole, DatabaseProvisionError, FreshInstallError, initializeFreshDatabase, normalizeFreshClient } from "@lms-core/db";

export async function runRuntimeInitialization(directory = __dirname) {
  const baseline = JSON.parse(await readFile(path.join(directory, "baseline-manifest.json"), "utf8"));
  const sql = await readFile(path.join(directory, "baseline.sql"), "utf8");
  const client = normalizeFreshClient(JSON.parse(process.env.LMS_RUNTIME_CLIENT_CONFIG || "null"));
  if (client.id !== (process.env.LMS_RUNTIME_CLIENT_ID || "").toLowerCase()) throw new FreshInstallError("INSTALLATION_CLIENT_MISMATCH");
  if (process.env.LMS_RUNTIME_REQUIRE_RESTRICTED_ROLE === "true") {
    await assertRestrictedDatabaseRole(process.env.DATABASE_URL || "", client.id);
  }
  return initializeFreshDatabase(process.env.DATABASE_URL || "", { ...baseline, sql }, client);
}

if (require.main === module) void runRuntimeInitialization().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error) => {
  const code = error instanceof FreshInstallError || error instanceof DatabaseProvisionError ? error.code : "INITIALIZATION_CONFIG_UNAVAILABLE";
  process.stderr.write(`${JSON.stringify({ initialized: false, error: code })}\n`);
  process.exitCode = 1;
});
