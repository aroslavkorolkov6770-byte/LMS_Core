(function (scope) {
  "use strict";
  const connectionKey = (target) => JSON.stringify([String(target.host).trim().toLowerCase(), Number(target.port), String(target.username).trim(), String(target.fingerprint).trim()]);
  function createServerAccess(options) {
    const { bridge, clientId, readTarget, applyTarget, field, button, note } = options;
    let loadedClient = "", revision = 0, savedKey = "", request = 0, busy = false, lookupTimer;
    const currentKey = () => `${clientId()}|${connectionKey(readTarget())}`;
    const render = () => {
      const saved = savedKey === currentKey();
      options.setLoading?.(busy || !!options.isBusy?.() || !clientId() || loadedClient !== clientId());
      field.readOnly = saved;
      field.placeholder = saved ? "Пароль сохранён в Windows" : "Пароль сервера";
      button.disabled = busy || !!options.isBusy?.() || !clientId() || loadedClient !== clientId() || options.authMode() !== "password";
      button.setAttribute("aria-pressed", String(saved));
      button.setAttribute("aria-label", saved ? "Удалить сохранённый пароль" : "Сохранить пароль");
      button.title = saved ? "Удалить сохранённый пароль и очистить поле" : "Сохранить пароль для клиента и сервера";
      button.dataset.locked = String(saved);
      note.textContent = saved ? "Сохранён для этого клиента и SSH-сервера. Нажмите замок ещё раз, чтобы удалить." : "Нажмите замок для сохранения после закрытия Core. Без замка пароль только в памяти окна.";
    };
    const accept = (profile, key) => { revision = profile.revision; savedKey = profile.passwordSaved && !field.value ? key : ""; render(); };
    async function load() {
      clearTimeout(lookupTimer);
      const token = ++request, id = clientId();
      loadedClient = ""; savedKey = ""; field.value = "";
      applyTarget(null); render();
      if (!id) return;
      try {
        let profile = await bridge.getClientServer(id);
        if (token !== request || id !== clientId()) return;
        // Only this client's installation receipt may seed a missing profile, never the former global host.
        if (!profile.target && options.seedTarget) {
          const target = await options.seedTarget(id);
          if (token !== request || id !== clientId()) return;
          if (target) profile = await bridge.saveClientServer(id, target, profile.revision);
        }
        if (token !== request || id !== clientId()) return;
        loadedClient = id; applyTarget(profile.target); accept(profile, currentKey());
      } catch (error) { if (token === request) { render(); options.onError(error); } }
    }
    async function saveTarget() {
      if (loadedClient !== clientId() || busy) throw Error("Дождитесь загрузки сервера выбранного клиента.");
      const id = clientId(), key = currentKey(), target = readTarget();
      const token = ++request; clearTimeout(lookupTimer); busy = true; render();
      try {
        const profile = await bridge.saveClientServer(id, target, revision);
        if (token !== request || id !== clientId() || key !== currentKey()) throw Error("Клиент или сервер изменился; команда не запущена.");
        accept(profile, key);
        return profile;
      } finally { busy = false; render(); }
    }
    async function toggle() {
      if (busy || options.isBusy?.() || loadedClient !== clientId()) return;
      const id = clientId(), key = currentKey(), target = readTarget(), forget = savedKey === key, password = field.value;
      busy = true; const token = ++request; clearTimeout(lookupTimer); render();
      try {
        const profile = await bridge.toggleClientServerPassword(id, target, password, revision, forget);
        if (token !== request || id !== clientId() || key !== currentKey()) return;
        field.value = ""; accept(profile, key);
      } catch (error) { if (token === request) options.onError(error); }
      finally { busy = false; render(); }
    }
    function changed() {
      ++request; clearTimeout(lookupTimer); savedKey = ""; field.value = ""; render();
      if (!clientId() || loadedClient !== clientId()) return;
      const token = request, id = clientId(), key = currentKey();
      lookupTimer = setTimeout(async () => {
        try {
          const profile = await bridge.getClientServer(id, readTarget());
          if (token !== request || id !== clientId() || key !== currentKey() || field.value) return;
          accept(profile, key);
        } catch { /* Incomplete address fields are not a profile load failure. No connection is made. */ }
      }, 180);
    }
    button.addEventListener("click", () => { void toggle(); });
    render();
    return { load, saveTarget, changed, isSaved: () => savedKey === currentKey(), refresh: render,
      ensureLoaded: async () => { if (loadedClient !== clientId()) await load(); } };
  }
  scope.coreServerAccess = { createServerAccess, connectionKey };
  if (typeof module !== "undefined") module.exports = scope.coreServerAccess;
})(typeof window !== "undefined" ? window : globalThis);
