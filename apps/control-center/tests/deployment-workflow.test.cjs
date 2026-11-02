const test = require("node:test");
const assert = require("node:assert/strict");
const { readiness, phaseLabel, adminIssue, isCancellation, matchesUpdateTarget } = require("../renderer/deployment-workflow.js");
const ready = { isNew: true, clientReady: true, connectionReady: true, sourceReady: true, planReady: true, packageReady: true, hasPreflight: true, fresh: true, prepared: true };

test("deployment workflow: missing client and SSH configuration lead to connection", () => {
  assert.equal(readiness({ ...ready, clientReady: false }).next, "connection");
  assert.equal(readiness({ ...ready, connectionReady: false }).next, "connection");
});
test("deployment workflow: missing source, plan and package lead to preparation", () => {
  for (const field of ["sourceReady", "planReady", "packageReady"]) assert.equal(readiness({ ...ready, [field]: false }).next, "preparation");
  assert.match(readiness({ ...ready, packageReady: false }).hint, /Собрать пакет/);
});
test("deployment workflow: expired check never tells operator to rebuild existing package", () => {
  const model = { ...ready, fresh: false }, snapshot = JSON.stringify(model);
  const result = readiness(model);
  assert.equal(result.next, "preparation"); assert.match(result.hint, /Повторите только/); assert.match(result.hint, /пересобирать не нужно/);
  assert.equal(JSON.stringify(model), snapshot);
});
test("deployment workflow: blocked and ready preflights are not confused", () => {
  assert.equal(readiness({ ...ready, prepared: false }).next, "preparation");
  assert.match(readiness({ ...ready, prepared: false }).installHint, /препятствия/);
  assert.equal(readiness(ready).next, "installation");
});

test("automatic PostgreSQL issue cannot be presented as a ready installation", () => {
  const issue = "PostgreSQL не установлена. Подготовьте Ubuntu.";
  assert.deepEqual(readiness({ ...ready, postgresIssue: issue }), { next: "preparation", hint: issue, installHint: issue });
  assert.equal(readiness({ ...ready, postgresIssue: "" }).next, "installation");
});
test("deployment workflow: running and installed states cannot suggest another launch", () => {
  assert.match(readiness({ ...ready, running: true }).hint, /не запускайте повторную/);
  assert.equal(readiness({ ...ready, installed: true }).next, "access");
  assert.match(readiness({ ...ready, installed: true }).installHint, /Повторный запуск заблокирован/);
});
test("deployment workflow: update mode remains a separate explicit operation", () => {
  const result = readiness({ isNew: false });
  assert.equal(result.next, "preparation"); assert.match(result.installHint, /подтверждаемой/);
});
test("deployment workflow: phase labels are static Russian text, never arbitrary server content", () => {
  assert.equal(phaseLabel("build"), "Сборка LMS");
  assert.equal(phaseLabel("initialize"), "Создание базы данных");
  assert.equal(phaseLabel("failed"), "Ошибка");
  assert.equal(phaseLabel("password=do-not-log"), "Выполнение команды");
});

test("saving AI settings must never imply a successful provider connection", () => {
  const { resultLabel } = require("../renderer/deployment-workflow.js");
  assert.equal(resultLabel("ai", "applied"), "ИИ: подключение не проверено");
  assert.equal(resultLabel("ai", "checked"), "ИИ: подключение не проверено");
  assert.equal(resultLabel("ai", "failed"), "Ошибка");
  assert.equal(resultLabel("installation", "succeeded"), "Успешно");
});
test("deployment workflow: admin validation agrees with installer bounds without logging values", () => {
  const input = { clientAdminLogin: "client.admin", systemAdminLogin: "system.admin", clientAdminName: "Admin", clientAdminPassword: "a".repeat(12), systemAdminPassword: "b".repeat(128) };
  assert.equal(adminIssue(input), null);
  assert.equal(adminIssue({ ...input, clientAdminPassword: "short" }).id, "install-client-password");
  assert.equal(adminIssue({ ...input, systemAdminPassword: "b".repeat(129) }).id, "install-system-password");
  assert.equal(adminIssue({ ...input, systemAdminLogin: "CLIENT.ADMIN" }).id, "install-system-login");
  assert.equal(adminIssue({ ...input, clientAdminLogin: "wrong login" }).id, "install-client-login");
  assert.equal(adminIssue({ ...input, clientAdminName: " " }).id, "install-client-name");
  assert.equal(JSON.stringify(adminIssue({ ...input, clientAdminPassword: "secret-value" })).includes("secret-value"), false);
});
test("deployment workflow: explicit user cancellation is not a server failure", () => {
  assert.equal(isCancellation("Error invoking remote method: Установка отменена; сервер не изменён."), true);
  assert.equal(isCancellation("Добавление swap отменено; сервер не изменен."), true);
  assert.equal(isCancellation("Сначала сохраните или отмените правки LMS."), false);
  assert.equal(isCancellation("Соединение прервано"), false);
});
test("deployment workflow: saved update for another server/path is never the current result", () => {
  const target = { host: "server.example", port: 22, username: "root", appPath: "/srv/lms/client" };
  assert.equal(matchesUpdateTarget(target, { ...target }), true);
  for (const [key, value] of Object.entries({ host: "other.example", port: 2222, username: "other", appPath: "/srv/lms/other" })) assert.equal(matchesUpdateTarget(target, { ...target, [key]: value }), false);
  assert.equal(matchesUpdateTarget(null, target), false);
});
