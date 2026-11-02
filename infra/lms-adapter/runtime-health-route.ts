import { readDataValue } from "@/app/lib/storage/dataStore";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const clientId = process.env.CORE_RUNTIME_CLIENT_ID || "";
    const releaseId = process.env.CORE_RUNTIME_RELEASE_ID || "";
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    if (!uuid.test(clientId) || !uuid.test(releaseId)) throw new Error("Runtime identity is missing");
    await readDataValue("core_runtime_health_probe_v1", null);
    return Response.json({ protocol: "lms-core-client-v1", service: "lms-client", status: "ok", clientId, releaseId, storage: "postgresql-runtime" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ protocol: "lms-core-client-v1", status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
