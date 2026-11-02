export type PanelAction = "create" | "profile" | "workflow" | "validate" | "package" | "health";
export type PanelOperation = { action: PanelAction; clientId: string | null; controller: AbortController };

export class PanelOperationGate {
  private active: PanelOperation | null = null;
  begin(action: PanelAction, clientId: string | null): PanelOperation | null {
    if (this.active) return null;
    this.active = { action, clientId, controller: new AbortController() };
    return this.active;
  }
  isCurrent(operation: PanelOperation, clientId: string | null): boolean {
    return this.active === operation && !operation.controller.signal.aborted && operation.clientId === clientId;
  }
  finish(operation: PanelOperation): boolean {
    if (this.active !== operation) return false;
    this.active = null;
    return true;
  }
  cancel(): void { this.active?.controller.abort(); this.active = null; }
}

export class PanelRequestError extends Error {
  constructor(public readonly kind: "timeout" | "aborted" | "network" | "invalid-response") {
    super(`Panel request: ${kind}`);
    this.name = "PanelRequestError";
  }
}

function safeFailurePayload(payload: unknown, status: number): Record<string, unknown> {
  if ([400, 409, 422].includes(status) && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as Record<string, unknown>).message;
    const lines = typeof message === "string" ? [message] : Array.isArray(message) ? message.filter((item): item is string => typeof item === "string") : [];
    if (lines.length) return { message: lines.slice(0, 12).map((line) => line.replace(/[\u0000-\u001f]/g, " ").slice(0, 180)).join("; ").slice(0, 800) };
  }
  return { message: status >= 500 ? "API не подтвердил выполнение. Проверь сервисы Core и состояние клиента перед повтором." : "Запрос отклонен. Проверь данные и доступ к клиенту." };
}

/** Read the complete JSON body before releasing the request deadline. No automatic retries for writes. */
export async function requestPanel(url: string, init: RequestInit, signal: AbortSignal, timeoutMs = 20000): Promise<{ ok: boolean; status: number; json(): Promise<Record<string, unknown>> }> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  if (signal.aborted) controller.abort(); else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw new PanelRequestError("aborted");
    const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
    let payload: unknown;
    try { payload = await response.json(); } catch (error) {
      if (controller.signal.aborted) throw error;
      if (!response.ok) payload = null; else throw new PanelRequestError("invalid-response");
    }
    if (response.ok && (!payload || typeof payload !== "object" || Array.isArray(payload))) throw new PanelRequestError("invalid-response");
    const safePayload = response.ok ? payload as Record<string, unknown> : safeFailurePayload(payload, response.status);
    return { ok: response.ok, status: response.status, json: async () => safePayload };
  } catch (error) {
    if (timedOut) throw new PanelRequestError("timeout");
    if (controller.signal.aborted) throw new PanelRequestError("aborted");
    if (error instanceof PanelRequestError) throw error;
    throw new PanelRequestError("network");
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

export function panelRequestFailure(error: unknown, mutating: boolean): string {
  const reason = error instanceof PanelRequestError && error.kind === "timeout" ? "Время ожидания истекло." : "Ответ API не получен или поврежден.";
  return `${reason} Введенные данные остались в форме.${mutating ? " Результат операции пока неизвестен: проверь карточку или список клиентов перед повтором." : " Проверь сервисы Core и повтори проверку."}`;
}
