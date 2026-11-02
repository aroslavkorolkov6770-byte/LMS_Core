export type CoreEditorState = { dirty: boolean; busy: boolean; blocked: boolean };

export function connectCoreEditorState(host: Window, clientId: string | null, state: () => CoreEditorState): () => void {
  if (host.parent === host) return () => {};
  const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_-]{1,128}$/i.test(value);
  let session = "", generation = 0, closed = false;
  const post = (data: unknown): void => {
    try { host.parent.postMessage(data, "*"); } catch { /* A closing desktop parent must not break the editor. */ }
  };
  const receive = (event: MessageEvent): void => {
    if (closed || event.source !== host.parent || !["null", "file://"].includes(event.origin)) return;
    const data = event.data;
    if (data?.type === "lms-core:client-context" && data.version === 1 && identifier(data.session)) {
      if (!Number.isSafeInteger(data.generation) || data.generation < 1 || data.generation < generation || (data.generation === generation && session && session !== data.session)) return;
      generation = data.generation; session = data.session;
      return;
    }
    if (data?.type !== "lms-core:panel-state-request" || data.version !== 1 || !session || data.session !== session || !identifier(data.requestId)) return;
    let snapshot: CoreEditorState = { dirty: true, busy: false, blocked: true };
    try {
      const value = state();
      if (typeof value.dirty === "boolean" && typeof value.busy === "boolean" && typeof value.blocked === "boolean") snapshot = { dirty: value.dirty, busy: value.busy, blocked: value.blocked };
    } catch { /* An unreadable draft blocks navigation rather than approving data loss. */ }
    post({ type: "lms-core:panel-state", version: 1, session, requestId: data.requestId, clientId, ...snapshot });
  };
  host.addEventListener("message", receive);
  post({ type: "lms-core:client-context-ready", version: 1 });
  return () => { closed = true; session = ""; host.removeEventListener("message", receive); };
}
