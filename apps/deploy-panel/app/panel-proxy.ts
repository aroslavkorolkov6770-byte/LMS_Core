import { NextRequest, NextResponse } from "next/server";
import { requestPanelBackend } from "./panel-backend";
import { PanelRequestError, panelRequestFailure } from "./panel-request";

function failure(error: unknown, mutating: boolean): NextResponse {
  const status = error instanceof PanelRequestError ? error.kind === "timeout" ? 504 : error.kind === "invalid-response" ? 502 : 503 : 503;
  return NextResponse.json({ message: panelRequestFailure(error, mutating) }, { status });
}

export async function forwardPanelPost(request: NextRequest, command: string, timeoutMs = 15000): Promise<NextResponse> {
  try {
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return NextResponse.json({ message: "Неверные данные запроса." }, { status: 400 });
    const response = await requestPanelBackend(`/api/deploy-panel/${command}`, { method: "POST", signal: request.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, timeoutMs);
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) { return failure(error, true); }
}

export async function forwardPanelValidation(request: NextRequest): Promise<NextResponse> {
  const clientId = request.nextUrl.searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ message: "Выбери клиента для проверки." }, { status: 400 });
  try {
    const response = await requestPanelBackend(`/api/deploy-panel/validate-client?clientId=${encodeURIComponent(clientId)}`, { method: "GET", signal: request.signal }, 25000);
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) { return failure(error, false); }
}
