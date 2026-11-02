(function (root, factory) {
  const workflow = factory();
  if (typeof module === "object" && module.exports) module.exports = workflow;
  else root.coreDeploymentWorkflow = workflow;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const stages = ["connection", "preparation", "installation", "access"];
  const titles = { connection: "Подключение к серверу", checks: "Проверка существующего сервера", plan: "Пакет и готовность сервера", memory: "Подготовка памяти", environment: "Подготовка Ubuntu", installation: "Установка LMS", update: "Обновление LMS", access: "Публичный доступ по IP" };
  const actions = {
    "lms-removal-prepare": ["removal", "Проверка удаления LMS и БД"], "lms-removal-execute": ["removal", "Полное удаление LMS и БД"], "lms-removal-refresh": ["removal", "Проверка результата удаления"],
    "ai-configuration-apply": ["ai", "Сохранение параметров ИИ"], "ai-configuration-check": ["ai", "Проверка параметров ИИ"],
    "ai-configuration-provision": ["ai", "Создание базы знаний и подключение ИИ"],
    "mail-configuration-apply": ["mail", "Сохранение почтовых параметров"], "mail-configuration-check": ["mail", "Чтение почтовых параметров"], "mail-configuration-test": ["mail", "Тестовое письмо"],
    "remote-save-button": ["connection", "Сохранение SSH-параметров"], "remote-probe-button": ["connection", "Получение отпечатка"], "remote-choose-key": ["connection", "Выбор SSH-ключа"],
    "remote-inspect-button": ["checks", "Проверка SSH-входа"], "remote-preflight-button": ["checks", "Готовность обновления"],
    "new-installation-prepare": ["plan", "Подготовка плана"], "new-installation-package": ["plan", "Сборка пакета"],
    "new-installation-server-check": ["plan", "Проверка сервера"], "prepare-server-memory": ["memory", "Подготовка swap"],
    "prepare-clean-server": ["environment", "Подготовка Ubuntu"], "refresh-server-preparation": ["environment", "Проверка подготовки Ubuntu"],
    "new-installation-start": ["installation", "Установка LMS"], "new-installation-refresh": ["installation", "Проверка результата установки"],
    "remote-deploy-button": ["update", "Обновление LMS"], "remote-deployment-refresh": ["update", "Проверка обновления"],
    "ip-publication-start": ["access", "Публикация по IP"], "ip-publication-check": ["access", "Проверка IP-доступа"], "ip-publication-https": ["access", "Настройка HTTPS"]
  };
  const phases = { preparing: "Подготовка", downloading: "Загрузка компонентов", connecting: "SSH-подключение", uploading: "Передача файлов", validating: "Проверка", provision: "Подготовка базы", provisioning: "Подготовка базы", installing: "Установка компонентов", dependencies: "Зависимости", build: "Сборка LMS", building: "Сборка LMS", stopping: "Остановка прежней службы", backup: "Резервная копия", switching: "Переключение версии", start: "Запуск служб", starting: "Запуск служб", health: "Проверка LMS", publishing: "Публикация", rolling_back: "Восстановление", succeeded: "Успешно", failed: "Ошибка", needs_attention: "Нужна проверка", disconnected: "Связь прервана", rolled_back: "Прежняя версия восстановлена" };
  const terminal = new Set(["succeeded", "failed", "needs_attention", "disconnected", "rolled_back", "cancelled"]);
  titles.ai = "Настройки ИИ выбранной LMS";
  titles.mail = "Почта уведомлений выбранной LMS";
  titles.removal = "Удаление LMS с сервера";
  Object.assign(phases, { uninstalled: "LMS и БД удалены", running: "Выполняется" });
  terminal.add("uninstalled");
  Object.assign(phases, { applying: "Применение настроек", applied: "Параметры применены", checked: "Параметры проверены" });
  terminal.add("applied"); terminal.add("checked");
  Object.assign(phases, { testing: "Отправка тестового письма", test_sent: "Письмо принято SMTP", test_failed: "Тестовое письмо не принято" });
  terminal.add("test_sent"); terminal.add("test_failed");
  Object.assign(phases, { verifying: "Проверка архива", extracting: "Распаковка пакета", validate: "Проверка пути и портов", reserve: "Подготовка каталогов", initialize: "Создание базы данных", bootstrap: "Создание администраторов", configure: "Настройка окружения", activate: "Запуск служб", commit: "Сохранение результата" });
  Object.assign(phases, { packages: "Установка пакетов Ubuntu", node: "Подготовка Node.js", postgres: "Проверка PostgreSQL" });
  phases.needs_attention = "Сбой установки — требуется восстановление";
  function phaseLabel(phase) { return phases[phase] || "Выполнение команды"; }
  function resultLabel(kind, phase) {
    if (kind === "ai" && ["applied", "checked"].includes(phase)) return "ИИ: подключение не проверено";
    return phaseLabel(phase);
  }
  function isCancellation(message) { return typeof message === "string" && /(?:Добавление swap|Подготовка|Публикация|Установка|Обновление|Удаление|Настройка ИИ|Настройка почты) отменен[оа]/i.test(message); }
  function matchesUpdateTarget(saved, current) {
    return Boolean(saved && current && ["host", "port", "username", "appPath"].every(key => String(saved[key] ?? "").trim() === String(current[key] ?? "").trim()));
  }
  function adminIssue(input) {
    for (const [key, id] of [["clientAdminLogin", "install-client-login"], ["systemAdminLogin", "install-system-login"]]) {
      if (!/^[a-z0-9][a-z0-9_.@+-]{0,119}$/i.test(input[key] || "")) return { id, message: "Логин: от 1 до 120 латинских букв, цифр или символов _ . @ + -. Первый символ — буква или цифра." };
    }
    if (input.clientAdminLogin.toLowerCase() === input.systemAdminLogin.toLowerCase()) return { id: "install-system-login", message: "Логины администратора клиента и системного администратора должны отличаться." };
    if (!input.clientAdminName?.trim() || input.clientAdminName.length > 150) return { id: "install-client-name", message: "Укажите имя администратора клиента, не длиннее 150 символов." };
    for (const [key, id] of [["clientAdminPassword", "install-client-password"], ["systemAdminPassword", "install-system-password"]]) if (typeof input[key] !== "string" || input[key].length < 12 || input[key].length > 128) return { id, message: "Пароль администратора должен содержать от 12 до 128 символов." };
    return null;
  }

  function readiness(model) {
    if (!model.isNew) return { next: "preparation", hint: "Обновление: проверьте SSH-вход и готовность, затем откройте шаг «Установка». Существующие данные должны сохраниться.", installHint: "Обновление существующей LMS выполняется отдельной подтверждаемой командой." };
    if (model.installed) return { next: "access", hint: "LMS установлена. На шаге «Открыть LMS» доступен SSH-просмотр и отдельная настройка IP-доступа.", installHint: "Установка завершена. Повторный запуск заблокирован; используйте проверку результата." };
    if (model.running) return { next: "installation", hint: "Установка выполняется. Этапы отображаются справа; не запускайте повторную установку.", installHint: "Операция уже запущена. Проверяйте результат, а не запускайте ее повторно." };
    if (!model.clientReady) return { next: "connection", hint: "Сначала выберите клиента над этим блоком.", installHint: "Не выбран клиент с доступной карточкой." };
    if (!model.connectionReady) return { next: "connection", hint: "Укажите сервер, пользователя и независимо подтвержденный отпечаток на шаге «Подключение».", installHint: "Заполните параметры подключения." };
    if (!model.sourceReady) return { next: "preparation", hint: "Получите код текущего Git-источника в блоке выше. Затем подготовьте план.", installHint: "Нет полученной версии текущего источника." };
    if (!model.planReady) return { next: "preparation", hint: "Подготовьте план для выбранного клиента, Git-версии и сервера.", installHint: "Подготовьте актуальный план." };
    if (!model.packageReady) return { next: "preparation", hint: "План сохранен. Нажмите «Собрать пакет»: Core проверит поддержку выбранной Git-версии. Это локальный шаг, не SSH-вход.", installHint: "Пакет выбранной Git-версии еще не собран или не прошел локальную проверку." };
    if (!model.fresh) return { next: "preparation", hint: model.hasPreflight ? "Срок проверки истек. Повторите только «Проверить сервер»; план и пакет пересобирать не нужно." : "Пакет готов. Нажмите «Проверить сервер».", installHint: "Нужна действующая проверка сервера (10 минут)." };
    if (model.postgresIssue) return { next: "preparation", hint: model.postgresIssue, installHint: model.postgresIssue };
    if (!model.prepared) return { next: "preparation", hint: "Есть блокирующие условия. Смотрите результат проверки справа; при необходимости раскройте подготовку окружения и памяти.", installHint: "Проверка выявила препятствия. Устраните их и повторите проверку сервера." };
    return { next: "installation", hint: "Пакет и сервер проверены. Перейдите к доступам и подтвердите установку.", installHint: "Перед запуском заполните PostgreSQL и новые учетные записи администраторов. Потребуется отдельное подтверждение." };
  }

  function create(document) {
    let stage = "connection", context = "", generation = 0, model = { isNew: true }, command = null, busy = false, resultKind = "connection";
    const jobs = new Map(), outcomes = new Map(), seen = new Map(), entries = [];
    const byId = id => document.getElementById(id);
    const defaultResult = () => ({ connection: "connection", preparation: model.isNew ? "plan" : "checks", installation: model.isNew ? "installation" : "update", access: "access" })[stage];
    function showResult(kind) {
      if (!Object.hasOwn(titles, kind)) return;
      resultKind = kind;
      document.querySelectorAll("[data-deploy-result]").forEach(el => el.classList.toggle("hidden", el.dataset.deployResult !== kind));
      byId("deployment-result-title").textContent = titles[kind];
    }
    function record(label, status) {
      // Only fixed action/phase labels reach history. Credentials and raw server output never do.
      entries.push({ label, status, at: new Date().toLocaleTimeString("ru-RU") });
      if (entries.length > 60) entries.shift();
      const list = byId("deployment-history"), following = list.scrollHeight - list.clientHeight - list.scrollTop < 32;
      const selected = document.defaultView.getSelection()?.toString();
      const oldScroll = list.scrollTop;
      const entry = entries[entries.length - 1];
      const row = document.createElement("li"), time = document.createElement("time"), text = document.createElement("span");
      time.textContent = entry.at; text.textContent = entry.label; row.dataset.status = entry.status; row.append(time, text); list.append(row);
      if (list.children.length > 60) list.firstElementChild.remove();
      byId("deployment-history-count").textContent = String(entries.length);
      byId("deployment-history-empty").classList.toggle("hidden", entries.length > 0);
      list.scrollTop = following && !selected ? list.scrollHeight : oldScroll;
    }
    function status(label, tone) { byId("deployment-operation-state").textContent = label; byId("deployment-operation-state").dataset.tone = tone; }
    function stageStatus() {
      const kind = defaultResult(), phase = outcomes.get(kind);
      if (phase) status(resultLabel(kind, phase), ["failed", "test_failed", "needs_attention", "disconnected", "rolled_back"].includes(phase) ? "error" : terminal.has(phase) ? "complete" : "running");
      else if (kind === "plan") status(model.prepared && model.fresh ? "Готово" : "Требует подготовки", model.prepared && model.fresh ? "complete" : "pending");
      else status("Ожидание", "idle");
    }
    function select(next, focus = false) {
      if (!stages.includes(next)) return;
      stage = next;
      document.querySelectorAll("[data-deploy-pane]").forEach(el => el.classList.toggle("hidden", el.dataset.deployPane !== stage));
      document.querySelectorAll("[data-deploy-stage]").forEach(el => {
        const selected = el.dataset.deployStage === stage;
        if (selected) el.setAttribute("aria-current", "step"); else el.removeAttribute("aria-current");
      });
      if (!busy && ![...jobs.values()].some(Boolean)) { showResult(defaultResult()); stageStatus(); }
      if (focus) { const heading = document.querySelector(`[data-deploy-pane="${stage}"] h3`); heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
    function update(nextModel) {
      model = nextModel;
      const next = readiness(model);
      byId("deployment-next-step").textContent = next.hint;
      byId("deployment-install-lock").textContent = next.installHint;
      byId("deployment-new-install-controls").classList.toggle("hidden", !model.isNew);
      byId("deployment-new-access").classList.toggle("hidden", !model.isNew);
      byId("deployment-access-hint").textContent = !model.isNew ? "Для обновленной установки используйте существующий адрес сайта. Эта команда открытия относится к новой установке Core." : model.installed ? "Установка подтверждена. Откройте LMS через SSH или настройте отдельный публичный вход." : "Открытие станет доступно после успешной установки выбранного клиента.";
      byId("deployment-plan-state").textContent = model.planReady ? "План соответствует клиенту, исходнику и серверу" : "Нужен актуальный план";
      byId("deployment-package-state").textContent = model.packageReady ? "Пакет собран и проверен" : model.planReady ? "Нужны сборка и проверка выбранной Git-версии" : "Сначала подготовьте план";
      byId("deployment-server-state").textContent = model.fresh ? model.prepared ? "Готов к установке" : "Есть блокирующие условия" : model.hasPreflight ? "Проверка истекла — повторите только ее" : "Проверка еще не выполнялась";
      const done = { connection: model.connectionReady && model.clientReady, preparation: model.prepared && model.fresh, installation: model.installed, access: false };
      document.querySelectorAll("[data-deploy-stage]").forEach(el => { el.dataset.state = done[el.dataset.deployStage] ? "done" : el.dataset.deployStage === next.next ? "next" : "waiting"; });
      if (!busy && ![...jobs.values()].some(Boolean) && resultKind === defaultResult()) stageStatus();
    }
    document.querySelectorAll("[data-deploy-stage], [data-deploy-next]").forEach(el => el.addEventListener("click", () => select(el.dataset.deployStage || el.dataset.deployNext, Boolean(el.dataset.deployNext))));
    byId("remote-connection-details").addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || button.disabled || !button.getClientRects().length || !actions[button.id]) return;
      command = actions[button.id]; showResult(command[0]);
    }, true);
    return {
      select, showResult, update,
      begin() { busy = true; const token = { generation, command: command || [defaultResult(), "Команда Core"] }; outcomes.delete(token.command[0]); status("Выполняется", "running"); showResult(token.command[0]); record(`${token.command[1]} — начало`, "running"); return token; },
      end(token, failed, cancelled = false) {
        if (token.generation !== generation) return;
        busy = false;
        if (cancelled) { record(`${token.command[1]} — отменено пользователем`, "cancelled"); status("Отменено", "idle"); return; }
        const phase = outcomes.get(token.command[0]), error = failed || ["failed", "test_failed", "needs_attention", "disconnected", "rolled_back"].includes(phase);
        record(`${token.command[1]} — ${error ? "ошибка / нужна проверка" : "команда завершена"}`, error ? "error" : "complete");
        if (error) status(failed ? "Ошибка команды" : phaseLabel(phase), "error");
        else if (![...jobs.values()].some(Boolean)) status(token.command[0] === "ai" ? resultLabel("ai", phase) : phase === "succeeded" ? "Успешно" : "Команда завершена", "complete");
      },
      progress(kind, state) {
        if (!state || !Object.hasOwn(titles, kind)) return;
        const phase = state.phase, key = `${state.id || state.jobId || kind}:${phase}`;
        const wasRunning = jobs.get(kind) === true;
        jobs.set(kind, !terminal.has(phase));
        outcomes.set(kind, phase);
        if (seen.get(kind) === key) return;
        seen.set(kind, key);
        const failed = ["failed", "test_failed", "needs_attention", "disconnected", "rolled_back"].includes(phase);
        // Restoring a saved result must not replace the operator's currently selected stage.
        if (busy || wasRunning || !terminal.has(phase) || defaultResult() === kind) {
          showResult(kind);
          status(resultLabel(kind, phase), failed ? "error" : terminal.has(phase) ? "complete" : "running");
        }
        record(`Состояние: ${titles[kind]} — ${resultLabel(kind, phase).toLowerCase()}`, failed ? "error" : terminal.has(phase) ? "complete" : "running");
      },
      setContext(clientId) {
        if (context === clientId) return;
        context = clientId; generation++; busy = false; command = null; jobs.clear(); outcomes.clear(); seen.clear(); entries.length = 0;
        byId("deployment-history").replaceChildren(); byId("deployment-history-count").textContent = "0"; byId("deployment-history-empty").classList.remove("hidden");
        byId("remote-feedback").textContent = "Команды для выбранного клиента в этом окне еще не выполнялись.";
        for (const id of ["remote-inventory", "remote-preflight-result", "server-memory-result", "server-preparation-result"]) byId(id).textContent = "";
        byId("new-installation-result").textContent = "Установка ещё не выполнялась.";
        byId("remote-deployment-result").textContent = "Результат обновления выбранного клиента нужно проверить отдельно.";
        byId("ip-publication-result").textContent = "Публичный вход выбранного клиента еще не проверен.";
        status("Ожидание", "idle"); select("connection");
      },
      revealInvalid(form) {
        const invalid = [...form.elements].find(el => typeof el.checkValidity === "function" && !el.disabled && !el.checkValidity());
        if (!invalid) return true;
        const pane = invalid.closest("[data-deploy-pane]"); if (pane) select(pane.dataset.deployPane);
        for (let parent = invalid.parentElement; parent && parent !== form; parent = parent.parentElement) if (parent.tagName === "DETAILS") parent.open = true;
        invalid.reportValidity(); return false;
      }
    };
  }
  function installedUpdateTarget(target, installed, clientId) {
    if (!installed || installed.clientId !== clientId || installed.phase !== "succeeded" || target.appPath || !installed.target?.appPath || !installed.target.fingerprint) return target;
    return ["host", "port", "username", "basePath", "fingerprint"].every(key => target[key] === installed.target[key]) ? { ...target, appPath: installed.target.appPath } : target;
  }
  return Object.freeze({ create, readiness, phaseLabel, resultLabel, adminIssue, isCancellation, matchesUpdateTarget, installedUpdateTarget });
});
