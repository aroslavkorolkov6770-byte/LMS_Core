import { PreviewRequestError, requestPreviewResponse } from "./preview-request";

/** Existing local control-plane identity; never send it to the embedded LMS or URL. */
export async function requestPreviewBackend<T>(endpoint: string, init: RequestInit = {}): Promise<{ payload: T; status: number }> {
  if (!endpoint.startsWith("/api/deploy-panel/")) throw new PreviewRequestError("invalid-response");
  const apiUrl = process.env.DEPLOY_PANEL_API_URL ?? "http://127.0.0.1:3001";
  const headers = new Headers(init.headers);
  headers.set("x-dev-role-code", "system_admin");
  headers.set("x-dev-user-id", process.env.DEPLOY_PANEL_DEV_USER_ID ?? "dev-user");
  headers.set("x-dev-client-id", process.env.DEPLOY_PANEL_DEV_CLIENT_ID ?? "dev-client");
  return requestPreviewResponse<T>(`${apiUrl}${endpoint}`, { ...init, headers, cache: "no-store" }, 10000);
}

export function previewBackendFailure(error: unknown): { status: number; message: string } {
  if (error instanceof PreviewRequestError) {
    if (error.kind === "timeout") return { status: 504, message: "API не ответил вовремя. Проверь сервисы Core и повтори попытку." };
    if (error.kind === "http" && error.status !== null && error.status >= 400 && error.status < 500) {
      return { status: error.status, message: error.status === 404 ? "Клиент или его настройки не найдены. Выбери клиента заново в Core." : "API отклонил запрос. Проверь данные клиента и повтори попытку." };
    }
    if (error.kind === "invalid-response") return { status: 502, message: "API вернул неверный ответ. Настройки клиента не изменены." };
  }
  return { status: 503, message: "API недоступен. Запусти сервисы Core и повтори попытку; настройки клиента не изменены." };
}
