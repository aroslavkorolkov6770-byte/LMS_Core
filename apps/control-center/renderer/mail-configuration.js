(function (root, factory) {
  const mail = factory();
  if (typeof module === "object" && module.exports) module.exports = mail;
  else root.coreMailConfiguration = mail;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const fields = { SMTP_HOST: "mail-host", SMTP_PORT: "mail-port", SMTP_SECURE: "mail-secure", SMTP_USER: "mail-user" };
  const defaults = { SMTP_HOST: "", SMTP_PORT: "", SMTP_SECURE: "true", SMTP_USER: "" };
  const email = value => typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
  function validate(values, passwordPresent) {
    if (!email(values.SMTP_USER)) return { id: "mail-user", message: "Укажите один адрес почты отправителя. Он используется также как SMTP-логин." };
    if (!values.SMTP_HOST || values.SMTP_HOST.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(values.SMTP_HOST) || values.SMTP_HOST.includes("..")) return { id: "mail-host", message: "Укажите SMTP-сервер без https://, пути и пробелов." };
    if (!/^\d{1,5}$/.test(values.SMTP_PORT) || Number(values.SMTP_PORT) < 1 || Number(values.SMTP_PORT) > 65535) return { id: "mail-port", message: "Укажите SMTP-порт из настроек почтового провайдера." };
    if (!["true", "false"].includes(values.SMTP_SECURE)) return { id: "mail-secure", message: "Выберите режим TLS или STARTTLS, указанный у почтового провайдера." };
    const password = values.SMTP_PASS || "";
    if (!password && !passwordPresent) return { id: "mail-password", message: "Введите пароль приложения для почты. Если он уже есть на сервере, сначала прочитайте настройки почты." };
    if (password && (password.length > 1024 || /[\x00-\x1f\x7f]/.test(password) || !password.trim() || ["'", "`", '"'].every(quote => password.includes(quote) || quote === '"' && /\\[nr]/.test(password)))) return { id: "mail-password", message: "Проверьте пароль приложения: без переносов строк, управляющих символов и неподдерживаемого сочетания кавычек." };
    return null;
  }
  function formatResult(state) {
    if (!state) return "Почта этого клиента еще не проверялась. Введите параметры или прочитайте настройки сервера.";
    const labels = { applying: "Сохраняю почтовые параметры.", testing: "Отправляю одно тестовое письмо.", applied: "Почтовые параметры записаны. Веб-служба перезапущена, LMS отвечает.", checked: "Окружение прочитано, LMS отвечает. Подключение к SMTP не выполнялось.", test_sent: "SMTP-сервер принял тестовое письмо. Проверьте входящие и Спам; это еще не гарантия конечной доставки.", test_failed: "Тестовое письмо не принято. Сохраненные настройки не изменялись.", failed: "Настройки не применены; проверьте результат отката.", needs_attention: "Результат не подтвержден. Сначала прочитайте настройки сервера." };
    const errors = { MAIL_AUTH_FAILED: "SMTP отклонил вход: проверьте адрес отправителя и пароль приложения.", MAIL_TIMEOUT: "SMTP не ответил вовремя: проверьте порт и сетевые ограничения хостера.", MAIL_CONNECTION_FAILED: "Не удалось подключиться к SMTP-серверу.", MAIL_TLS_OR_CONNECTION_FAILED: "Ошибка TLS или соединения: проверьте SMTP-сервер, порт и сертификат.", MAIL_TLS_FAILED: "Не удалось установить защищенное SMTP-соединение.", MAIL_RECIPIENT_REJECTED: "SMTP отклонил адрес получателя.", MAIL_EXISTING_PASSWORD_REFERENCE: "Старый пароль задан ссылкой на другую переменную окружения. Вставьте пароль приложения явно: Core не станет заменять ссылку догадкой.",
      MAIL_CONTACT_SOURCE_CHANGED: "Исходник установленной LMS отличается от проверенной версии. Core не перезаписывал его; сначала нужно согласовать изменения.",
      MAIL_CONTACT_BUILD_CHANGED: "Во время подготовки изменилась сборка LMS. Повторите действие после завершения другого обновления.",
      MAIL_CONTACT_DISK_LOW: "Для первой сборки контакта поддержки требуется не менее 2 ГиБ свободного места на сервере.",
      MAIL_CONTACT_MEMORY_LOW: "Для первой сборки контакта поддержки требуется не менее 3 ГиБ RAM + swap. Используйте подготовку памяти сервера в Core.",
      MAIL_CONTACT_BUILD_FAILED: "Не удалось собрать контакт поддержки. Работающий сайт не переключался; требуется проверить совместимость исходника.",
      MAIL_CONTACT_BUILD_TIMEOUT: "Первая сборка контакта поддержки не завершилась за 45 минут. Работающий сайт не переключался.",
      MAIL_CONTACT_HEALTH_FAILED: "Сайт не подтвердил новый контакт поддержки. Проверьте результат восстановления прежней версии." };
    return [labels[state.phase] || "Результат неизвестен.", `Отправитель: ${state.SMTP_USER || "не задан"}`, `Поддержка на сайте: ${state.supportContactReady ? state.supportEmail || "не задана" : "адаптер еще не подтвержден; примените настройки"}`, ...(state.buildPerformed ? ["Адаптер поддержки собран и включен. Дальнейшая смена адреса не требует сборки."] : []), `SMTP: ${state.SMTP_HOST || "не задан"}:${state.SMTP_PORT || "-"}`, `Режим: ${state.SMTP_SECURE === "true" ? "TLS" : state.SMTP_SECURE === "false" ? "STARTTLS" : "не задан"}`,
      `Пароль в окружении: ${state.passwordPresent ? "присутствует (значение скрыто)" : "не подтвержден"}`, ...(state.testRecipient ? [`Получатель теста: ${state.testRecipient}`] : []),
      ...(state.errorCode ? [errors[state.errorCode] || `Код: ${state.errorCode}`] : []), ...(state.rollbackRestored === true ? ["Прежняя конфигурация сохранена или восстановлена."] : []),
      ...(state.updatedAt ? [`Обновлено: ${new Date(state.updatedAt).toLocaleString("ru-RU")}`] : [])].join("\n");
  }
  function create(document) {
    const byId = id => document.getElementById(id);
    let context = "", state = null, baseline = { ...defaults }, enabled = false, busy = false;
    const values = () => ({ ...Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, byId(id).value.trim()])), SMTP_PASS: byId("mail-password").value });
    const dirty = () => Boolean(byId("mail-password").value) || Object.entries(fields).some(([key, id]) => byId(id).value.trim() !== baseline[key]);
    function render() {
      byId("mail-configuration-apply").disabled = !enabled || busy;
      byId("mail-configuration-check").disabled = !enabled || busy;
      byId("mail-configuration-test").disabled = !enabled || busy || dirty() || !state?.configured || !email(byId("mail-test-recipient").value.trim());
      byId("mail-configuration-clear").disabled = busy || !dirty();
      byId("mail-starttls-warning").classList.toggle("hidden", byId("mail-secure").value !== "false");
      byId("mail-password-presence").textContent = state?.passwordPresent ? "Пароль есть на сервере. Пустое поле оставит его без изменения." : "Пароль до применения находится только в памяти окна, не сохраняется на диск Core и не выводится в журнал.";
      byId("mail-configuration-result").textContent = formatResult(state);
    }
    for (const id of [...Object.values(fields), "mail-password", "mail-test-recipient"]) byId(id).addEventListener("input", render);
    byId("mail-configuration-clear").addEventListener("click", () => {
      if (busy || !document.defaultView.confirm("Очистить несохраненные почтовые параметры? На сервере почта и пароль не удаляются.")) return;
      byId("mail-password").value = ""; for (const [key, id] of Object.entries(fields)) byId(id).value = baseline[key]; render();
    });
    document.defaultView.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
    return { dirty, values, context: () => context, recipient: () => byId("mail-test-recipient").value.trim(),
      setContext(next) { if (context === next) return false; context = next; state = null; baseline = { ...defaults }; for (const [key, id] of Object.entries(fields)) byId(id).value = baseline[key]; byId("mail-password").value = ""; byId("mail-test-recipient").value = ""; render(); return true; },
      setEnabled(ready, working) { enabled = ready; busy = working; render(); },
      receive(next, applied = false) {
        state = next;
        if (next && ["applied", "checked", "test_sent", "test_failed"].includes(next.phase)) {
          const hadDraft = Object.entries(fields).some(([key, id]) => byId(id).value.trim() !== baseline[key]);
          for (const [key, id] of Object.entries(fields)) if (!hadDraft || !byId(id).value.trim()) byId(id).value = next[key] || defaults[key];
          baseline = Object.fromEntries(Object.keys(fields).map(key => [key, next[key] || defaults[key]]));
          if (applied && next.phase === "applied") byId("mail-password").value = "";
        }
        render();
      },
      issue(action) {
        if (action === "test") {
          if (dirty()) return { id: "mail-configuration-apply", message: "Сначала сохраните почтовые параметры. Тест использует только сохраненное серверное окружение." };
          return email(this.recipient()) ? null : { id: "mail-test-recipient", message: "Укажите один адрес получателя тестового письма." };
        }
        return validate(values(), state?.passwordPresent === true);
      }
    };
  }
  return Object.freeze({ create, validate, email, formatResult });
});
