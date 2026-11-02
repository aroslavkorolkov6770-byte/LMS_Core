(function () {
  "use strict";
  window.CorePointInspector = {
    create({ bridge, layout }) {
      const byId = (id) => document.getElementById(id);
      const panel = byId("point-inspector"), toggle = byId("point-editor-toggle"), workspace = byId("point-workspace");
      let state = { catalog: [], fonts: {}, dirty: false, busy: false }, ready = false, open = false, received = false;
      let pending, sending, desired, sendError, frame = 0, selected = "", scope = "light", error = "";
      const valueInputs = ["point-text", "point-font", "point-size", "point-weight"];
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const patch = () => desired?.id === selected ? desired.patch || {} : state.document?.elements[selected] || {};
      const setValue = (id, value) => { const element = byId(id); if (document.activeElement !== element) element.value = value ?? ""; };
      const hex = (value) => {
        if (/^#[a-f0-9]{6}$/i.test(String(value))) return value;
        const rgb = String(value || "").match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return rgb ? "#" + rgb.slice(1).map((item) => Number(item).toString(16).padStart(2, "0")).join("") : "#808080";
      };
      function render() {
        const usable = ready || state.dirty || state.busy;
        panel.classList.toggle("hidden", !open || !usable);
        workspace.classList.toggle("has-inspector", open && usable);
        toggle.disabled = !usable || !state.document || state.busy;
        toggle.textContent = state.dirty ? "Редактор · есть правки" : "Редактировать LMS";
        toggle.setAttribute("aria-pressed", String(open));
        const descriptor = state.catalog.find((item) => item.id === selected), current = patch(), properties = current.styles?.[scope] || {};
        byId("point-status").textContent = error || state.error || (state.busy ? "Сохраняю..." : state.dirty && !ready ? "Просмотр остановлен. Черновик можно сохранить или отменить; затем повторить запуск." : state.dirty || pending || sending ? "Есть несохранённые правки." : `Сохранено · версия ${state.revision || 0}. Выберите элемент в LMS.`);
        byId("point-pick").textContent = state.enabled ? "Выбор включён · нажмите в LMS" : "Выбрать элемент в LMS";
        byId("point-pick").setAttribute("aria-pressed", String(state.enabled));
        byId("point-pick").disabled = !ready || state.busy;
        byId("point-fields").classList.toggle("hidden", !descriptor);
        if (descriptor) {
          byId("point-text-row").classList.toggle("hidden", descriptor.text === null);
          byId("point-text").placeholder = descriptor.text || "Исходная подпись";
          setValue("point-text", current.text);
          for (const row of panel.querySelectorAll("[data-point-property]")) row.classList.toggle("hidden", !descriptor.properties.includes(row.dataset.pointProperty));
          for (const key of ["color", "backgroundColor", "borderColor"]) {
            const input = panel.querySelector(`[data-point-value="${key}"]`), color = panel.querySelector(`[data-point-color="${key}"]`);
            if (document.activeElement !== input) input.value = properties[key] || "";
            if (document.activeElement !== color) color.value = hex(properties[key] || state.computed?.[key]);
          }
          setValue("point-font", properties.fontFamily); setValue("point-size", properties.fontSizePx); setValue("point-weight", properties.fontWeight);
        }
        for (const input of panel.querySelectorAll("input,select,textarea")) input.disabled = state.busy || !ready;
        byId("point-save").disabled = !state.dirty && !desired && !sending || state.busy;
        byId("point-discard").disabled = !state.dirty && !desired && !sending || state.busy;
        byId("point-reset-element").disabled = !descriptor || state.busy || !ready;
        byId("point-reload").disabled = state.busy || !state.document;
        layout();
      }
      function accept(value) {
        received = true;
        state = value;
        if (selected !== state.selectedId) {
          selected = state.selectedId; scope = state.selectedTheme || "light";
          byId("point-scope").value = scope; byId("point-element").value = selected;
        }
        if (byId("point-element").options.length !== state.catalog.length + 1) {
          byId("point-element").replaceChildren(new Option("Нажмите на элемент в LMS", ""), ...state.catalog.map((item) => new Option(item.label, item.id)));
          byId("point-element").value = selected;
          const labels = { humanist: "Гуманистический", geometric: "Геометрический", editorial: "Книжный", mono: "Моноширинный" };
          byId("point-font").replaceChildren(new Option("Исходный шрифт", ""), ...Object.entries(state.fonts).filter(([, font]) => font).map(([id, font]) => new Option(labels[id] || id, font)));
        }
        render();
      }
      async function run(callback) {
        error = "";
        try { const result = await callback(); if (result?.catalog) accept(result); }
        catch (reason) { error = reason instanceof Error ? reason.message : "Не удалось выполнить действие. Черновик не сброшен."; }
        finally { render(); }
      }
      async function send() {
        frame = 0;
        if (sending || !pending) return;
        const next = pending; pending = undefined;
        sending = bridge.changePointElement(next.id, next.patch);
        try { accept(await sending); sendError = undefined; if (desired === next) desired = undefined; }
        catch (reason) { sendError = reason; error = reason instanceof Error ? reason.message : "Правка не применена. Повторите изменение или отмените черновик."; }
        finally { sending = undefined; if (pending) await send(); else render(); }
      }
      async function flush() {
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        while (sending || pending) { if (sending) { try { await sending; } catch { /* The dispatch stores a readable error and preserves the local draft. */ } } else await send(); }
        if (sendError) throw sendError;
      }
      function queue(next) {
        if (!selected || state.busy) return;
        desired = pending = { id: selected, patch: next }; error = ""; sendError = undefined;
        if (!frame && !sending) frame = requestAnimationFrame(() => { void send(); });
        render();
      }
      function property(key, value) {
        const next = clone(patch()); next.styles ||= {}; next.styles[scope] ||= {};
        if (value === "") delete next.styles[scope][key]; else next.styles[scope][key] = value;
        queue(next);
      }
      async function close() { await flush(); if (!ready && state.dirty) { error = "Сначала сохраните или отмените оставшийся черновик."; render(); return; } open = false; await run(() => bridge.enablePointEditor(false)); }
      toggle.addEventListener("click", () => { if (open) void run(close); else { open = true; if (ready) void run(() => bridge.enablePointEditor(true)); else render(); } });
      byId("point-close").addEventListener("click", () => { void run(close); });
      byId("point-pick").addEventListener("click", () => { void run(() => bridge.enablePointEditor(!state.enabled)); });
      byId("point-element").addEventListener("change", async (event) => {
        await flush();
        // The same allowlist is used for the selector and click-to-select path.
        selected = event.target.value; state.selectedId = selected;
        await run(() => bridge.selectPointElement(selected));
      });
      byId("point-scope").addEventListener("change", async (event) => { await flush(); scope = event.target.value; render(); });
      byId("point-text").addEventListener("input", (event) => { const next = clone(patch()); if (event.target.value.trim()) next.text = event.target.value; else delete next.text; queue(next); });
      for (const input of panel.querySelectorAll("[data-point-color]")) input.addEventListener("input", (event) => property(input.dataset.pointColor, event.target.value));
      for (const input of panel.querySelectorAll("[data-point-value]")) input.addEventListener("input", (event) => { if (!event.target.value || /^#[a-f0-9]{6}$/i.test(event.target.value)) property(input.dataset.pointValue, event.target.value); });
      for (const button of panel.querySelectorAll("[data-point-reset]")) button.addEventListener("click", () => property(button.dataset.pointReset, ""));
      byId("point-font").addEventListener("change", (event) => property("fontFamily", event.target.value));
      byId("point-size").addEventListener("input", (event) => { const value = event.target.value; if (!value || Number.isInteger(Number(value)) && Number(value) >= 10 && Number(value) <= 64) property("fontSizePx", value ? Number(value) : ""); });
      byId("point-weight").addEventListener("change", (event) => property("fontWeight", event.target.value ? Number(event.target.value) : ""));
      byId("point-reset-element").addEventListener("click", () => queue(null));
      byId("point-save").addEventListener("click", () => { void run(async () => { await flush(); return bridge.savePointEditor(); }); });
      byId("point-discard").addEventListener("click", () => { void run(async () => { try { await flush(); } catch { /* Discard is still available after a failed local patch. */ } const result = await bridge.discardPointEditor(); if (!result.dirty) { desired = pending = undefined; sendError = undefined; } return result; }); });
      byId("point-reload").addEventListener("click", () => { void run(async () => { try { await flush(); } catch { /* Re-reading is the explicit recovery path for a save conflict. */ } const result = await bridge.reloadPointEditor(); if (!result.dirty) { desired = pending = undefined; sendError = undefined; } return result; }); });
      bridge.onPointEditorState?.(accept);
      if (bridge.getPointEditor) void bridge.getPointEditor().then((value) => { if (!received) accept(value); }).catch(() => { error = "Не удалось загрузить редактор."; render(); });
      window.addEventListener("beforeunload", (event) => { if (state.dirty || state.busy || desired || sending) { event.preventDefault(); event.returnValue = ""; } });
      return { hasUnsaved: () => Boolean(state.dirty || state.busy || desired || sending), setReady(value) { ready = value; render(); }, flush };
    }
  };
})();
