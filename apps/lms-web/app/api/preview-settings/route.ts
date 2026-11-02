import { NextRequest, NextResponse } from "next/server";
import { previewBackendFailure, requestPreviewBackend } from "../../lib/preview-backend";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const clientId = request.nextUrl.searchParams.get("clientId");

  if (!clientId) {
    return NextResponse.json({ message: "clientId is required" }, { status: 400 });
  }

  try {
    const { payload, status } = await requestPreviewBackend(`/api/deploy-panel/preview-settings?clientId=${encodeURIComponent(clientId)}`, { signal: request.signal });
    return NextResponse.json(payload, { status });
  } catch (error) {
    const failure = previewBackendFailure(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const payload = await request.json().catch(() => null);

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const payloadRecord = payload as Record<string, unknown>;
  const settingsRecord =
    payloadRecord.settings && typeof payloadRecord.settings === "object" && !Array.isArray(payloadRecord.settings)
      ? (payloadRecord.settings as Record<string, unknown>)
      : null;
  const settingsWithoutVersion = settingsRecord ? { ...settingsRecord } : {};
  delete settingsWithoutVersion.version;
  const normalizedPayload =
    settingsRecord
      ? {
          ...settingsWithoutVersion,
          clientId: payloadRecord.clientId
        }
      : payload;

  try {
    const { payload: responsePayload, status } = await requestPreviewBackend("/api/deploy-panel/preview-settings", {
      method: "POST",
      signal: request.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizedPayload)
    });
    return NextResponse.json(responsePayload, { status });
  } catch (error) {
    const failure = previewBackendFailure(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
