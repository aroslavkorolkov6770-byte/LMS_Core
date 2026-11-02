(function (root, factory) {
  const preferences = factory();
  if (typeof module === "object" && module.exports) module.exports = preferences;
  else root.corePreferences = preferences;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const themes = Object.freeze({
    midnight: { label: "Полночь", light: false, background: "#080c12", text: "#e8f0f7" },
    graphite: { label: "Графит", light: false, background: "#18191c", text: "#f0f0f2" },
    ocean: { label: "Океан", light: false, background: "#0b1724", text: "#e5f1ff" },
    forest: { label: "Хвойный", light: false, background: "#101b18", text: "#e5f1e9" },
    ember: { label: "Терракота", light: false, background: "#201713", text: "#f7eee7" },
    sand: { label: "Песок", light: true, background: "#f1ece4", text: "#302921" },
    porcelain: { label: "Фарфор", light: true, background: "#f5f6f8", text: "#202b3b" },
    mist: { label: "Туман", light: true, background: "#edf3f0", text: "#20382d" }
  });
  const defaults = Object.freeze({
    theme: "midnight", density: "comfortable", textSize: "normal", sidebarWidth: "standard",
    detailLevel: "essential", reducedMotion: false, maximizeOnStart: true,
    defaultView: "overview", rememberLastView: true, autoFocusPreview: true,
    statusInterval: 5000, autoRefreshLogs: true, uiFont: "technical", contentWidth: "full",
    borderContrast: "soft", showServiceSummary: true, keyboardShortcuts: true,
    logWrap: false, logLineLimit: 1000, logInterval: 2500
  });
  // One allowlist is shared by the renderer and Electron: no secrets or remote permissions belong here.
  function normalize(input) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const result = { ...defaults };
    const enums = {
      theme: Object.keys(themes), density: ["comfortable", "compact"], textSize: ["normal", "large"],
      sidebarWidth: ["standard", "narrow"], detailLevel: ["essential", "detailed"],
      defaultView: ["overview", "services", "browser", "lms", "database", "repository", "logs", "settings"],
      statusInterval: [5000, 10000, 30000], uiFont: ["humanist", "technical", "system"],
      contentWidth: ["full", "focused"], borderContrast: ["soft", "strong"],
      logLineLimit: [300, 1000, 3000], logInterval: [2500, 5000, 10000]
    };
    for (const [key, values] of Object.entries(enums)) {
      if (Object.hasOwn(source, key) && values.includes(source[key])) result[key] = source[key];
    }
    for (const key of ["reducedMotion", "maximizeOnStart", "rememberLastView", "autoFocusPreview", "autoRefreshLogs", "showServiceSummary", "keyboardShortcuts", "logWrap"]) {
      if (typeof source[key] === "boolean") result[key] = source[key];
    }
    return result;
  }
  return Object.freeze({ themes, defaults, normalize });
});
