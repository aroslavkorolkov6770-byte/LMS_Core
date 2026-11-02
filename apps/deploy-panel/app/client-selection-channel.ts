type ClientChoice = { id: string; name: string } | null;

export function connectCoreClientSelection(host: Window, currentClient: () => ClientChoice, currentPanelState: () => { dirty: boolean; busy: boolean; blocked: boolean } = () => ({ dirty: false, busy: false, blocked: false })): { publish: () => void; close: () => void } {
  if (host.parent === host) return { publish() {}, close() {} };
  let session = "", revision = 0, generation = 0, lastSent = "", closed = false;
  const post = (data: unknown): void => {
    // The desktop parent has an opaque file origin; the receiver binds source, local origin and nonce.
    try { host.parent.postMessage(data, "*"); } catch { /* A closing parent must not break the standalone panel. */ }
  };
  const publish = (): void => {
    if (closed || !session) return;
    const client = currentClient();
    if (!client || !/^[a-z0-9_-]{1,128}$/i.test(client.id) || !client.name.trim() || client.name.length > 1000 || /[\u0000-\u001f\u007f]/.test(client.name)) return;
    const signature = JSON.stringify([session, client.id, client.name]);
    if (signature === lastSent) return;
    lastSent = signature;
    post({ type: "lms-core:client-selection", version: 1, session, revision: ++revision, clientId: client.id, name: client.name });
  };
  const receive = (event: MessageEvent): void => {
    if (closed || event.source !== host.parent || !["null", "file://"].includes(event.origin)) return;
    const data = event.data;
    if (data?.type === "lms-core:panel-state-request" && data.version === 1 && session && data.session === session && typeof data.requestId === "string" && /^[a-z0-9_-]{1,128}$/i.test(data.requestId)) {
      try {
        const state = currentPanelState();
        post({ type: "lms-core:panel-state", version: 1, session, requestId: data.requestId, clientId: currentClient()?.id ?? null, dirty: state.dirty, busy: state.busy, blocked: state.blocked });
      } catch {
        post({ type: "lms-core:panel-state", version: 1, session, requestId: data.requestId, clientId: null, dirty: true, busy: false, blocked: true });
      }
      return;
    }
    if (data?.type !== "lms-core:client-context" || data.version !== 1 || typeof data.session !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(data.session)) return;
    if (!Number.isSafeInteger(data.generation) || data.generation < 1 || data.generation < generation || (data.generation === generation && session && session !== data.session)) return;
    generation = data.generation;
    if (session !== data.session) { session = data.session; revision = 0; lastSent = ""; }
    publish();
  };
  host.addEventListener("message", receive);
  post({ type: "lms-core:client-context-ready", version: 1 });
  return { publish, close() { closed = true; session = ""; host.removeEventListener("message", receive); } };
}
