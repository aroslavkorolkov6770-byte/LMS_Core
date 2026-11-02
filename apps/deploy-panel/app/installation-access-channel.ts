let context: { session: string; generation: number } | null = null;
let started = false;
const pending = new Map<string, { session: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("message", event => {
    if (event.source !== window.parent || !["null", "file://"].includes(event.origin)) return;
    const data = event.data;
    if (data?.type === "lms-core:client-context" && data.version === 1 && typeof data.session === "string" && Number.isSafeInteger(data.generation) && (!context || data.generation >= context.generation)) { context = { session: data.session, generation: data.generation }; return; }
    if (data?.type !== "lms-core:installation-access-result" || data.version !== 1) return;
    const request = pending.get(data.requestId);
    if (!request || data.session !== request.session || data.session !== context?.session) return;
    clearTimeout(request.timer); pending.delete(data.requestId);
    if (data.ok === true) request.resolve(data.value);
    else request.reject(Error(typeof data.error === "string" ? data.error : "Доступы не сохранены."));
  });
}

export async function installationAccessRequest(action: "get" | "save" | "capture", clientId: string, values?: unknown, revision?: number): Promise<any> {
  start();
  if (window.parent === window) throw Error("Защищенные пароли для установки сохраняются в приложении LMS Core, не в отдельной вкладке браузера.");
  if (!context) {
    window.parent.postMessage({ type: "lms-core:client-context-ready", version: 1 }, "*");
    for (let i = 0; i < 30 && !context; i++) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!context) throw Error("Связь с хранилищем Core не готова. Откройте карточку внутри приложения.");
  const session = context.session, requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error("Core не подтвердил сохранение доступов. Перечитайте карточку перед повтором.")); }, 20000);
    pending.set(requestId, { session, resolve, reject, timer });
    // Only the trusted desktop parent receives this message. Nothing is persisted in browser storage.
    window.parent.postMessage({ type: "lms-core:installation-access", version: 1, session, requestId, action, clientId, values, revision }, "*");
  });
}
