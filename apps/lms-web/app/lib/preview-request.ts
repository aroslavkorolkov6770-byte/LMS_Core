export type PreviewRequestFailure = "timeout" | "aborted" | "network" | "http" | "invalid-response";

export class PreviewRequestError extends Error {
  constructor(public readonly kind: PreviewRequestFailure, public readonly status: number | null = null) {
    super(`Preview request: ${kind}${status === null ? "" : ` (${status})`}`);
    this.name = "PreviewRequestError";
  }
}

/** Bound the complete request, including JSON parsing, and release its timer/listener on every exit. */
export async function requestPreviewResponse<T>(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<{ payload: T; status: number }> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  const signal = init.signal;
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw new PreviewRequestError("aborted");
    const response = await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
    if (!response.ok) throw new PreviewRequestError("http", response.status);
    try {
      return { payload: await response.json() as T, status: response.status };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new PreviewRequestError("invalid-response");
    }
  } catch (error) {
    if (timedOut) throw new PreviewRequestError("timeout");
    if (controller.signal.aborted) throw new PreviewRequestError("aborted");
    if (error instanceof PreviewRequestError) throw error;
    // Do not expose raw network messages, URLs, or backend response bodies in the editor.
    throw new PreviewRequestError("network");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function requestPreviewJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  return (await requestPreviewResponse<T>(url, init, timeoutMs)).payload;
}

export function previewSaveFailureMessage(error: unknown): string {
  if (error instanceof PreviewRequestError && (error.kind === "timeout" || error.kind === "network" || error.kind === "aborted" || error.kind === "invalid-response")) {
    return "Подтверждение сохранения не получено. Черновик сохранен в панели; перед повтором проверь сохраненную версию клиента.";
  }
  return "Сервер не подтвердил сохранение. Черновик остался в панели; проверь API и базу.";
}
