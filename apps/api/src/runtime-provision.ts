import { Readable } from "node:stream";
import { DatabaseProvisionError, provisionClientDatabase, provisionLocalClientDatabase } from "@lms-core/db";

export async function readProvisionInput(stream: Readable = process.stdin, timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      stream.off("data", onData); stream.off("end", onEnd); stream.off("error", onError);
      stream.pause();
      if (error) reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const value = Buffer.from(chunk); bytes += value.length;
      if (bytes > 16384) { finish(new DatabaseProvisionError("DATABASE_PROVISION_INPUT_TOO_LARGE")); return; }
      chunks.push(value);
    };
    const onError = () => finish(new DatabaseProvisionError("DATABASE_PROVISION_INPUT_UNAVAILABLE"));
    const onEnd = () => {
      finish();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new DatabaseProvisionError("INVALID_DATABASE_PROVISION_INPUT")); }
    };
    const timer = setTimeout(() => finish(new DatabaseProvisionError("DATABASE_PROVISION_INPUT_TIMEOUT")), timeoutMs);
    stream.on("data", onData); stream.once("end", onEnd); stream.once("error", onError);
  });
}

export async function runRuntimeProvisioning(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DatabaseProvisionError("INVALID_DATABASE_PROVISION_INPUT");
  const value = input as Record<string, unknown>;
  const peer = value.localPeer === true;
  const allowed = [peer ? "localPeer" : "maintenanceUrl", "clientId", "jobId", "password"];
  if (Object.keys(value).length !== allowed.length || allowed.some((key) => key === "localPeer" ? value[key] !== true : typeof value[key] !== "string") ||
    Object.keys(value).some((key) => !allowed.includes(key))) throw new DatabaseProvisionError("INVALID_DATABASE_PROVISION_INPUT");
  const request = { clientId: value.clientId as string, jobId: value.jobId as string, password: value.password as string };
  return peer ? provisionLocalClientDatabase(request) : provisionClientDatabase(value.maintenanceUrl as string, request);
}

if (require.main === module) void readProvisionInput().then(runRuntimeProvisioning).then((result) => {
  // The caller already holds the service password; stdout contains only the public receipt.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error) => {
  const known = error instanceof DatabaseProvisionError;
  process.stderr.write(`${JSON.stringify({ provisioned: false, error: known ? error.code : "DATABASE_PROVISION_FAILED", requiresAttention: known && error.requiresAttention })}\n`);
  process.exitCode = 1;
});
