(function (root, factory) {
  const tools = factory();
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.coreWorkspaceTools = tools;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function logTail(content, limit) {
    const text = typeof content === "string" ? content : "";
    const count = [300, 1000, 3000].includes(limit) ? limit : 1000;
    // Find the visible tail without splitting a large log into thousands of strings.
    let end = text.length;
    if (text.endsWith("\n")) end--;
    let cursor = end;
    for (let lines = 0; lines < count; lines++) {
      cursor = text.lastIndexOf("\n", cursor - 1);
      if (cursor < 0) return text;
    }
    return text.slice(cursor + 1);
  }

  function navigationShortcut(event, enabled, editing, modalOpen) {
    if (!enabled || editing || modalOpen || event.defaultPrevented || event.repeat || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
    if (event.code === "Comma") return "settings";
    const views = ["overview", "services", "browser", "lms", "database", "repository", "logs", "settings"];
    const match = /^Digit([1-8])$/.exec(event.code || "");
    return match ? views[Number(match[1]) - 1] : null;
  }

  async function readInstallationSnapshot(bridge, clientId) {
    // These are independent local reads. Apply them together so a partial reply cannot unlock installation.
    const [plan, state, publication] = await Promise.all([
      () => bridge.getInstallationPlan(clientId),
      () => bridge.getInstallationState ? bridge.getInstallationState(clientId) : null,
      () => bridge.getIpPublication ? bridge.getIpPublication(clientId) : null
    ].map(read => Promise.resolve().then(read)));
    return { plan, state, publication };
  }

  return Object.freeze({ logTail, navigationShortcut, readInstallationSnapshot });
});
