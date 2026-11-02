(function (root, factory) {
  const ai = factory();
  if (typeof module === "object" && module.exports) module.exports = ai;
  else root.coreAiConfiguration = ai;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const fields = { AI_PROJECT_ID: "ai-project-id", AI_PROMPT_ID: "ai-prompt-id", AI_VECTOR_STORE_ID: "ai-vector-store-id" };
  function identifierIssue(values) {
    for (const [key, id] of Object.entries(fields)) if (/^\d+$/.test(values[key] || "")) return { id, message: "Нужны настоящие ID каталога, агента/Prompt и Vector Store из Yandex AI Studio. Номер клиента вроде 0001 не подходит; одного API-ключа недостаточно." };
    return null;
  }
  function validate(values, keyPresent, provision = false) {
    const checked = provision ? { ...values, AI_VECTOR_STORE_ID: "core-auto-pending" } : values;
    for (const [key, id] of Object.entries(fields)) if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(checked[key] || "")) return { id, message: "Заполните ID каталога Yandex Cloud и совместимого Prompt клиента. Для ручного подключения также нужен ID Vector Store." };
    const issue = identifierIssue(checked); if (issue) return issue;
    if (!values.AI_API_KEY && !keyPresent) return { id: "ai-api-key", message: "Введите API-токен Alice AI. Если он уже есть на сервере, сначала нажмите «Проверить настройки ИИ»." };
    if (values.AI_API_KEY && !/^[A-Za-z0-9_./~+%=:!-]{1,8192}$/.test(values.AI_API_KEY)) return { id: "ai-api-key", message: "Вставьте только API-токен: без Bearer, пробелов, переносов строк и кавычек." };
    return null;
  }
  function formatResult(state) {
    if (!state) return "Настройки ИИ этого клиента еще не проверялись. Токен вводится только в Core.";
    const label = { applying: "Настройки отправляются на сервер.", applied: "Параметры записаны, LMS отвечает. Подключение к ИИ НЕ проверено.", checked: "Наличие параметров прочитано; LMS отвечает. Подключение к ИИ НЕ проверено.", failed: "Изменения не применены; проверьте результат отката.", needs_attention: "Применение не подтверждено. Сначала проверьте сохраненные настройки." };
    const errors = { AI_PROVIDER_KEY_REJECTED: "Яндекс не принял API-ключ. Введите действующий ключ в Core и повторите.", AI_PROVIDER_PERMISSION_DENIED: "Нет прав на каталог или управление индексами. Проверьте роли сервисного аккаунта и область действия ключа в Яндексе.", AI_INDEX_CREATION_UNCONFIRMED: "Ответ создания потерян. Повторная команда сначала ищет уже созданную свою базу и не создает дубль вслепую.", AI_INDEX_REQUEST_REJECTED: "Яндекс отклонил параметры. Проверьте ID каталога: это не ID ключа.", AI_PROVIDER_RATE_LIMIT: "Лимит API Яндекса. Подождите перед повтором; генерация не запускалась.", AI_INDEX_NOT_FOUND: "Ранее созданная база не найдена. Core не заменяет ее новой автоматически.", AI_INDEX_OWNER_MISMATCH: "База не подтверждена как собственный ресурс этого клиента.", AI_INDEX_MULTIPLE_OWNED: "У клиента обнаружено несколько баз Core. Автоматический выбор заблокирован.", AI_INDEX_NETWORK_UNAVAILABLE: "Сервер LMS не смог связаться с API Яндекса. Настройки не заменены.", AI_INDEX_NOT_READY: "База еще не готова. Повторите команду позже: новая база вместо нее не создается.", AI_INDEX_EXPIRATION_UNSUPPORTED: "У базы включено автоматическое истечение. Подключение заблокировано, чтобы не потерять знания клиента." };
    return [label[state.phase] || "Результат не подтвержден.", `Токен в окружении: ${state.apiKeyPresent ? "присутствует (значение не показывается)" : "не подтвержден"}`,
      ...Object.keys(fields).map(key => `${key}: ${state[key] || "не задан"}`), ...(state.envFile ? [`Файл: ${state.envFile}`] : []),
      ...(identifierIssue(state) ? [identifierIssue(state).message] : []),
      ...(state.indexId ? [`База знаний Core: ${state.indexReused ? "повторно использована своя" : "подготовлена"}; ID: ${state.indexId}`, state.phase === "applied" ? "ID базы применен к LMS. Запрос к модели не выполнялся." : "База сохранена для повтора; применение к LMS пока не подтверждено."] : []),
      ...(state.errorCode ? [`Код: ${state.errorCode}`] : []), ...(state.rollbackRestored === true ? [state.errorCode === "AI_CHANGE_NOT_APPLIED" ? "Изменения не производились." : "Прежняя конфигурация сохранена или восстановлена."] : []),
      ...(errors[state.errorCode] ? [errors[state.errorCode]] : []),
      "Действительность токена, права и оплата у провайдера этой проверкой не подтверждаются.", ...(state.updatedAt ? [`Обновлено: ${new Date(state.updatedAt).toLocaleString("ru-RU")}`] : [])].join("\n");
  }
  function create(document) {
    const byId = id => document.getElementById(id);
    let context = "", state = null, baseline = {}, enabled = false, busy = false;
    const values = () => ({ ...Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, byId(id).value.trim()])), AI_API_KEY: byId("ai-api-key").value.trim() });
    const dirty = () => Boolean(byId("ai-api-key").value) || Object.entries(fields).some(([key, id]) => byId(id).value.trim() !== (baseline[key] || ""));
    function render() {
      byId("ai-configuration-apply").disabled = !enabled || busy;
      byId("ai-configuration-provision").disabled = !enabled || busy;
      byId("ai-configuration-check").disabled = !enabled || busy;
      byId("ai-configuration-clear").disabled = busy || !dirty();
      byId("ai-key-presence").textContent = state?.apiKeyPresent ? "Токен есть на сервере. Пустое поле оставит его без изменения." : "До применения токен находится только в памяти окна Core и не сохраняется на диск. Наличие на сервере пока не подтверждено.";
      byId("ai-configuration-result").textContent = formatResult(state);
    }
    for (const id of [...Object.values(fields), "ai-api-key"]) byId(id).addEventListener("input", render);
    byId("ai-configuration-clear").addEventListener("click", () => {
      if (busy || !document.defaultView.confirm("Очистить несохраненный ввод ИИ? На сервере настройки и токен не удаляются.")) return;
      byId("ai-api-key").value = ""; for (const [key, id] of Object.entries(fields)) byId(id).value = baseline[key] || ""; render();
    });
    document.defaultView.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
    return {
      dirty, values,
      setContext(next) { if (context === next) return false; context = next; state = null; baseline = {}; for (const id of [...Object.values(fields), "ai-api-key"]) byId(id).value = ""; render(); return true; },
      context: () => context,
      setEnabled(ready, working) { enabled = ready; busy = working; render(); },
      receive(next, applied = false) {
        state = next;
        if (next && ["applied", "checked"].includes(next.phase)) {
          const hadIdDraft = Object.entries(fields).some(([key, id]) => byId(id).value.trim() !== (baseline[key] || ""));
          for (const [key, id] of Object.entries(fields)) if (applied || !hadIdDraft || !byId(id).value.trim()) byId(id).value = next[key] || "";
          baseline = Object.fromEntries(Object.keys(fields).map(key => [key, next[key] || ""]));
          if (applied && next.phase === "applied") byId("ai-api-key").value = "";
        }
        render();
      },
      issue: (provision = false) => validate(values(), state?.apiKeyPresent === true, provision)
    };
  }
  return Object.freeze({ create, validate, formatResult, identifierIssue });
});
