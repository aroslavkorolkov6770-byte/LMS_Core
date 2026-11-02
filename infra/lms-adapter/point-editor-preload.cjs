"use strict";

// This function is copied into the install payload as a normal JS module, not evaluated from a document.
function createPointRuntime(window, catalog, initialDocument, onSelect = () => {}) {
  const document = window.document;
  let design = initialDocument, enabled = false, selected = "", frame = 0, disposed = false;
  const changed = new Map();
  let overlay, stylesheet;
  const cssNames = { color: "color", backgroundColor: "background-color", borderColor: "border-color", fontFamily: "font-family", fontSizePx: "font-size", fontWeight: "font-weight" };
  const textOf = (element) => element.textContent.trim().replace(/\s+/g, " ");
  function matches(descriptor) {
    if (window.location.pathname.replace(/\/$/, "") !== descriptor.route) return [];
    return [...document.querySelectorAll(descriptor.selector)].filter((element) => {
      if (descriptor.text === null) return true;
      const text = textOf(element);
      const override = design.elements[descriptor.id]?.text;
      return text === descriptor.text || typeof override === "string" && text === override.trim().replace(/\s+/g, " ");
    }).slice(0, 12);
  }
  const observe = () => observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  function restore() {
    for (const [element, record] of changed) {
      if (record.text && element.textContent === record.text.last) element.textContent = record.text.original;
      element.removeAttribute("data-core-point");
    }
    changed.clear();
  }
  function highlight() {
    if (!enabled) { overlay?.remove(); overlay = undefined; return; }
    const descriptor = catalog.find((item) => item.id === selected), element = descriptor && matches(descriptor)[0];
    if (!element) { if (overlay) overlay.style.display = "none"; return; }
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute("data-core-point-highlight", "true");
      overlay.setAttribute("aria-hidden", "true");
      overlay.style.cssText = "position:fixed;pointer-events:none;border:2px solid #28a7a0;box-shadow:0 0 0 2px #fff8;border-radius:4px;z-index:2147483647;box-sizing:border-box;";
      document.documentElement.appendChild(overlay);
    }
    const rect = element.getBoundingClientRect();
    Object.assign(overlay.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function apply() {
    frame = 0;
    if (disposed) return;
    observer.disconnect();
    try {
      restore();
      const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      const rules = [];
      for (const descriptor of catalog) {
        const patch = design.elements[descriptor.id];
        if (!patch) continue;
        for (const element of matches(descriptor)) {
          const record = {};
          // Only static, text-only labels may change: icons, links, inputs and user content stay intact.
          if (patch.text !== undefined && !element.children.length && element.textContent !== patch.text) {
            record.text = { original: element.textContent, last: patch.text };
            element.textContent = patch.text;
          }
          const properties = { ...patch.styles?.all, ...patch.styles?.[theme] };
          const declarations = [];
          for (const [key, value] of Object.entries(properties)) {
            const property = cssNames[key];
            if (!property || !descriptor.properties.includes(key)) continue;
            declarations.push(`${property}:${key === "fontSizePx" ? `${value}px` : String(value)}!important`);
          }
          element.setAttribute("data-core-point", descriptor.id);
          // Preserve the original style attribute: the source UI itself uses [style*=...] selectors.
          if (declarations.length) rules.push(`${Array(8).fill(`[data-core-point="${descriptor.id}"]`).join("")}{${declarations.join(";")}}`);
          changed.set(element, record);
        }
      }
      if (rules.length && !stylesheet) { stylesheet = document.createElement("style"); stylesheet.setAttribute("data-core-point-style", "true"); document.head.appendChild(stylesheet); }
      if (stylesheet && stylesheet.textContent !== rules.join("\n")) stylesheet.textContent = rules.join("\n");
      highlight();
    } finally { if (!disposed) observe(); }
  }
  function schedule() { if (!frame && !disposed) frame = window.requestAnimationFrame(apply); }
  const observer = new window.MutationObserver(schedule);
  function describe(descriptor, element) {
    const computed = window.getComputedStyle(element);
    onSelect({ id: descriptor.id, theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light", computed: { color: computed.color, backgroundColor: computed.backgroundColor, borderColor: computed.borderColor, fontFamily: computed.fontFamily, fontSizePx: parseFloat(computed.fontSize), fontWeight: Number(computed.fontWeight) } });
  }
  function select(event) {
    if (!enabled || !(event.target instanceof window.Element)) return;
    const candidates = catalog.flatMap((descriptor) => matches(descriptor).map((element) => ({ descriptor, element }))).filter(({ element }) => element.contains(event.target));
    const picked = candidates.find(({ element }) => !candidates.some((other) => other.element !== element && element.contains(other.element)));
    // A selection click never activates another button or follows a link, even outside the allowlist.
    event.preventDefault(); event.stopImmediatePropagation();
    if (!picked) { onSelect({ unavailable: true }); return; }
    selected = picked.descriptor.id;
    describe(picked.descriptor, picked.element);
    observer.disconnect(); highlight(); observe();
  }
  const scroll = () => { if (enabled) { observer.disconnect(); highlight(); observe(); } };
  const pointer = (event) => { if (enabled) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const keyboard = (event) => {
    if (!enabled) return;
    if (["Enter", " ", "Escape"].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
    if (event.key === "Escape") { enabled = false; schedule(); onSelect({ exitSelection: true }); }
  };
  document.addEventListener("click", select, true);
  document.addEventListener("pointerdown", pointer, true); document.addEventListener("keydown", keyboard, true);
  window.addEventListener("scroll", scroll, true); window.addEventListener("resize", scroll);
  apply();
  return {
    update(next) { design = next; schedule(); },
    select(id) {
      if (selected !== id) { selected = id; const descriptor = catalog.find((item) => item.id === id), element = descriptor && matches(descriptor)[0]; if (element && enabled) describe(descriptor, element); }
      schedule();
    },
    enable(value) { enabled = value === true; if (enabled && document.activeElement?.blur) document.activeElement.blur(); schedule(); },
    dispose() {
      disposed = true; observer.disconnect(); if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener("click", select, true); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", scroll);
      document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", keyboard, true);
      overlay?.remove(); stylesheet?.remove(); restore();
    }
  };
}

if (typeof module !== "undefined") module.exports = { createPointRuntime };
if (typeof process !== "undefined" && process.type === "renderer") {
  const { ipcRenderer } = require("electron");
  let runtime, session;
  ipcRenderer.on("core-point:document", (_event, config) => {
    if (!config || typeof config.session !== "string" || !Array.isArray(config.catalog) || !config.document) return;
    if (session !== config.session) { runtime?.dispose(); runtime = undefined; session = config.session; }
    if (!runtime) runtime = createPointRuntime(window, config.catalog, config.document, (selection) => ipcRenderer.send("core-point:selection", { session, selection }));
    else runtime.update(config.document);
    runtime.enable(config.enabled); runtime.select(config.selectedId || "");
  });
  window.addEventListener("DOMContentLoaded", () => ipcRenderer.send("core-point:ready"), { once: true });
}
