(function (root) {
  "use strict";
  const repoIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/></svg>';
  const editIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6z"/></svg>';
  function create(options) {
    const byId = (id) => document.getElementById(id);
    const form = byId("source-library-form"), list = byId("source-library-list"), feedback = byId("source-library-feedback");
    let state = null, editingId = null, revision = 0, baseline = "", busy = false, generation = 0;
    const fields = () => ({ name: byId("source-library-name").value, url: byId("source-library-url").value, branch: byId("source-library-branch").value, note: byId("source-library-note").value });
    const dirty = () => !form.classList.contains("hidden") && baseline !== JSON.stringify(fields());
    const say = (message, error = false) => { feedback.textContent = message; feedback.dataset.error = String(error); };
    const node = (tag, className, text) => { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; };
    function render() {
      byId("source-library-add").disabled = busy || !state;
      byId("source-library-count").textContent = state ? `Источников: ${state.sources.length}` : "Ваши Git-репозитории";
      byId("source-library-empty").classList.toggle("hidden", !state || state.sources.length > 0);
      const config = options.repository()?.config;
      const cards = (state?.sources || []).map((source) => {
        const card = node("article", "source-card"), heading = node("div", "source-card-heading");
        card.dataset.sourceId = source.id;
        const icon = node("span", "source-card-icon"); icon.innerHTML = repoIcon;
        const title = node("h3", "", source.name), identity = node("div", "source-card-identity"); identity.append(title);
        const current = config?.url === source.url && config?.branch === source.branch;
        if (current) identity.append(node("span", "source-current-label", "Текущий"));
        const edit = node("button", "source-icon-button button-secondary"); edit.type = "button"; edit.innerHTML = editIcon;
        edit.setAttribute("aria-label", `Редактировать источник ${source.name}`); edit.title = "Название и заметка"; edit.disabled = busy;
        edit.addEventListener("click", () => showForm(source));
        heading.append(icon, identity, edit);
        const address = node("p", "source-card-address", source.url); address.title = source.url;
        const note = node("p", "source-card-note", source.note || "Заметка пока не добавлена");
        if (!source.note) note.classList.add("is-empty");
        const footer = node("div", "source-card-footer"), branch = node("span", "source-branch", source.branch || "Основная ветка"); branch.title = source.branch || "Основная ветка репозитория";
        const open = node("button", "button-secondary source-open-button", "Открыть"); open.type = "button"; open.disabled = busy;
        open.setAttribute("aria-label", `Открыть источник ${source.name}`);
        open.addEventListener("click", () => { void Promise.resolve().then(() => options.open(source)).catch((error) => say(error.message || "Не удалось открыть источник.", true)); });
        footer.append(branch, open); card.append(heading, address, note, footer); return card;
      });
      list.replaceChildren(...cards);
    }
    function showForm(source = null) {
      if (busy || dirty() && !window.confirm("Отменить несохраненные изменения источника?")) return;
      editingId = source?.id || null; revision = state.revision;
      byId("source-library-form-title").textContent = source ? "Редактировать источник" : "Новый источник";
      for (const [key, value] of Object.entries({ name: source?.name || "", url: source?.url || "", branch: source?.branch || "", note: source?.note || "" })) byId("source-library-" + key).value = value;
      byId("source-library-form-error").textContent = "";
      baseline = JSON.stringify(fields()); form.classList.remove("hidden"); form.scrollIntoView({ block: "nearest" }); byId("source-library-name").focus();
    }
    async function load() {
      const request = ++generation;
      say("Загружаю источники..."); byId("source-library-add").disabled = true;
      try {
        if (!options.bridge?.getSourceLibrary) throw Error("Для каталога источников перезапустите Core после обновления.");
        const result = await options.bridge.getSourceLibrary();
        if (request !== generation) return;
        state = result; say(""); byId("source-library-retry").classList.add("hidden"); render();
      } catch (error) {
        if (request !== generation) return;
        say(error.message || "Не удалось прочитать источники.", true); byId("source-library-retry").classList.remove("hidden"); render();
      }
    }
    byId("source-library-add").addEventListener("click", () => showForm());
    byId("source-library-retry").addEventListener("click", () => { void load(); });
    byId("source-library-cancel").addEventListener("click", () => { if (!busy && (!dirty() || window.confirm("Отменить несохраненные изменения источника?"))) form.classList.add("hidden"); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); if (busy || !form.reportValidity()) return;
      const input = { ...fields(), ...(editingId ? { id: editingId } : {}) };
      busy = true; render(); form.setAttribute("aria-busy", "true");
      form.querySelectorAll("input, textarea, button").forEach((element) => { element.disabled = true; });
      byId("source-library-save").textContent = "Сохраняю..."; byId("source-library-form-error").textContent = "";
      try {
        state = await options.bridge.saveSourceLibraryEntry(input, revision);
        baseline = JSON.stringify(fields()); form.classList.add("hidden"); say("Источник сохранён на этом компьютере.");
      } catch (error) { byId("source-library-form-error").textContent = error.message || "Не удалось сохранить. Введенные данные остались в форме."; }
      finally {
        busy = false; form.setAttribute("aria-busy", "false"); form.querySelectorAll("input, textarea, button").forEach((element) => { element.disabled = false; });
        byId("source-library-save").textContent = "Сохранить источник"; render();
      }
    });
    window.addEventListener("beforeunload", (event) => { if (dirty() || busy) { event.preventDefault(); event.returnValue = ""; } });
    return { load, render, hasUnsaved: dirty };
  }
  root.coreSourceLibrary = Object.freeze({ create });
})(globalThis);
