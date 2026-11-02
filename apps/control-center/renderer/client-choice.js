(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.coreClientChoice = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const keys = { id: "control-center.preview-client-id", name: "control-center.preview-client-name" };
  const limits = { id: 128, name: 1000 };

  function normalize(field, value) {
    if (typeof value !== "string" || value.length > limits[field] || /[\u0000-\u001f\u007f]/.test(value)) return "";
    if (field === "id" && value && !/^[a-z0-9_-]+$/i.test(value)) return "";
    return value;
  }

  function createClientChoiceStore(getStorage, onUnavailable) {
    const memory = { id: "", name: "" };
    let unavailable = false;
    function fail() {
      unavailable = true;
      // A storage error must not turn the warning itself into another initialization failure.
      try { if (typeof onUnavailable === "function") onUnavailable(); } catch { /* Keep the in-memory selection usable. */ }
    }
    function checkField(field) {
      if (!Object.hasOwn(keys, field)) throw new Error("Unknown client-choice field");
    }
    function get(field) {
      checkField(field);
      if (!unavailable) {
        try { memory[field] = normalize(field, getStorage().getItem(keys[field])); }
        catch { fail(); }
      }
      return memory[field];
    }
    function set(field, value) {
      checkField(field);
      memory[field] = normalize(field, value);
      if (!unavailable) {
        try { getStorage().setItem(keys[field], memory[field]); }
        catch { fail(); }
      }
    }
    return { get, set };
  }

  return { createClientChoiceStore };
});
