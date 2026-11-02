(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.corePanelSelection = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const identifier = (value) => typeof value === "string" && /^[a-z0-9_-]{1,128}$/i.test(value);
  function createPanelSelectionSession(makeNonce) {
    let nonce = "", expectedClientId = "", acknowledged = false, revision = 0, generation = 0;
    function invalidate() { nonce = ""; expectedClientId = ""; acknowledged = false; revision = 0; }
    function begin(clientId) {
      invalidate();
      nonce = makeNonce();
      if (!identifier(nonce)) { invalidate(); throw new Error("Invalid panel session nonce"); }
      expectedClientId = identifier(clientId) ? clientId : "";
      generation += 1;
    }
    function envelope() { return nonce ? { type: "lms-core:client-context", version: 1, session: nonce, generation } : null; }
    function accept(event, source, origin) {
      if (!nonce || event.source !== source || event.origin !== origin) return null;
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== "lms-core:client-selection" || data.version !== 1 || data.session !== nonce) return null;
      if (!Number.isSafeInteger(data.revision) || data.revision <= revision || !identifier(data.clientId)) return null;
      if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 1000 || /[\u0000-\u001f\u007f]/.test(data.name)) return null;
      // An old document still loading during a parent-initiated switch must not select its former client.
      if (!acknowledged && expectedClientId && data.clientId !== expectedClientId) return null;
      acknowledged = true; revision = data.revision;
      return { id: data.clientId, name: data.name };
    }
    function acceptState(event, source, origin, requestId) {
      if (!nonce || event.source !== source || event.origin !== origin) return null;
      const data = event.data;
      if (!data || data.type !== "lms-core:panel-state" || data.version !== 1 || data.session !== nonce || data.requestId !== requestId) return null;
      if (typeof data.dirty !== "boolean" || typeof data.busy !== "boolean" || typeof data.blocked !== "boolean" || (data.clientId !== null && !identifier(data.clientId))) return null;
      if (!acknowledged && expectedClientId && data.clientId !== expectedClientId && !data.blocked) return null;
      return { dirty: data.dirty, busy: data.busy, blocked: data.blocked, clientId: data.clientId };
    }
    return { begin, envelope, accept, acceptState, invalidate };
  }
  return { createPanelSelectionSession };
});
