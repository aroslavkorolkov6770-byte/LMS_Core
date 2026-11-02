"use client";

import { useEffect } from "react";

const themeNames = ["midnight", "graphite", "ocean", "forest", "ember", "sand", "porcelain", "mist"];
const lightThemes = ["sand", "porcelain", "mist"];

// This bridge accepts appearance only. It cannot change a client's branding, data, or deploy policy.
export function CoreAppearance(): null {
  useEffect(() => {
    const apply = (input: unknown): void => {
      if (!input || typeof input !== "object") return;
      const settings = input as Record<string, unknown>;
      const theme = typeof settings.theme === "string" && themeNames.includes(settings.theme) ? settings.theme : "midnight";
      const root = document.documentElement;
      root.dataset.coreTheme = theme;
      root.dataset.coreColorScheme = lightThemes.includes(theme) ? "light" : "dark";
      root.dataset.coreDensity = settings.density === "compact" ? "compact" : "comfortable";
      root.dataset.coreTextSize = settings.textSize === "large" ? "large" : "normal";
      root.dataset.coreReducedMotion = String(settings.reducedMotion === true);
      root.dataset.coreDetailLevel = settings.detailLevel === "detailed" ? "detailed" : "essential";
      root.dataset.coreUiFont = ["humanist", "technical", "system"].includes(String(settings.uiFont)) ? String(settings.uiFont) : "technical";
      root.dataset.coreBorderContrast = settings.borderContrast === "strong" ? "strong" : "soft";
      try {
        localStorage.setItem("lms-core.panel-appearance.v1", JSON.stringify({ theme, density: root.dataset.coreDensity, textSize: root.dataset.coreTextSize, reducedMotion: settings.reducedMotion === true, detailLevel: root.dataset.coreDetailLevel, uiFont: root.dataset.coreUiFont, borderContrast: root.dataset.coreBorderContrast }));
      } catch { /* Appearance still works if browser storage is disabled. */ }
    };
    try { apply(JSON.parse(localStorage.getItem("lms-core.panel-appearance.v1") || "{}")); }
    catch { apply({}); }
    const receive = (event: MessageEvent): void => {
      if (window.parent === window || event.source !== window.parent || !["null", "file://"].includes(event.origin)) return;
      if (event.data?.type !== "lms-core:appearance" || event.data?.version !== 1) return;
      apply(event.data);
    };
    window.addEventListener("message", receive);
    // The host validates this frame's exact configured local origin before replying.
    if (window.parent !== window) window.parent.postMessage({ type: "lms-core:appearance-ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, []);
  return null;
}
