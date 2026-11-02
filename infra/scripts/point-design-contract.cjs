"use strict";

const FORMAT = "lms-client-point-design-v3";
const MAX_BYTES = 128 * 1024;
const FONTS = {
  source: "",
  humanist: '"Segoe UI Variable", "Segoe UI", sans-serif',
  geometric: '"Avenir Next", "Trebuchet MS", sans-serif',
  editorial: 'Georgia, "Times New Roman", serif',
  mono: 'Consolas, "Courier New", monospace'
};
const textStyles = ["color", "fontFamily", "fontSizePx", "fontWeight"];
const boxStyles = ["backgroundColor", "borderColor"];
const loginFile = "app/login/page.tsx";
const entry = (id, label, route, selector, text, file, anchor, box = false) => ({ id, label, route, selector, text, file, anchor, properties: text === null ? boxStyles : box ? [...textStyles, ...boxStyles] : textStyles });

// Selectors are part of the reviewed adapter, never supplied by a document or renderer.
const CATALOG = [
  entry("login.story", "Фон блока с логотипом", "/login", ".vates-auth-story", null, loginFile, 'className="vates-auth-story"'),
  entry("login.storyTitle", "Заголовок рядом с логотипом", "/login", ".vates-auth-message > h1", "Обучение команды — под вашим контролем.", loginFile, "Обучение команды — под вашим контролем."),
  entry("login.storyDescription", "Описание рядом с логотипом", "/login", ".vates-auth-message > p", "Отслеживайте прохождение, ответы и пробелы в знаниях, чтобы вовремя подключать наставника и принимать решения на фактах.", loginFile, "Отслеживайте прохождение, ответы и пробелы"),
  entry("login.card", "Карточка входа", "/login", ".login-box", null, loginFile, 'className="login-box"'),
  entry("login.title", "Заголовок входа", "/login", ".login-card-heading > h1", "Вход в Ватэс", loginFile, "Вход в Ватэс"),
  entry("register.title", "Заголовок регистрации", "/login", ".login-card-heading > h1", "Активация аккаунта", loginFile, "Активация аккаунта"),
  entry("login.description", "Пояснение входа", "/login", ".login-card-heading > p", "Введите данные, чтобы продолжить обучение.", loginFile, "Введите данные, чтобы продолжить обучение."),
  entry("register.description", "Пояснение регистрации", "/login", ".login-card-heading > p", "Проверьте выданные данные и заполните профиль.", loginFile, "Проверьте выданные данные и заполните профиль."),
  entry("login.submit", "Кнопка входа", "/login", "button.hover-unified-auth", "ВОЙТИ", loginFile, "onClick={handleLogin}", true),
  entry("register.submit", "Кнопка регистрации", "/login", "button.hover-unified-auth", "ЗАРЕГИСТРИРОВАТЬСЯ", loginFile, "onClick={handleRegister}", true),
  entry("admin.title", "Заголовок рабочего пространства", "/admin", "#vates-workspace-title", "Рабочее пространство", "app/admin/components/VatesAdminOverview.tsx", 'id="vates-workspace-title"'),
  entry("admin.description", "Описание рабочего пространства", "/admin", "#vates-workspace-title + p", "Сводка по сотрудникам, учебным материалам и результатам.", "app/admin/components/VatesAdminOverview.tsx", "Сводка по сотрудникам, учебным материалам и результатам."),
  entry("profile.card", "Карточка профиля", "/profile", ".vates-profile-person-card", null, "app/profile/page.tsx", 'className="vates-profile-person-card"'),
  entry("profile.title", "Заголовок профиля", "/profile", ".vates-personal-profile-heading > div > h1", "Мой профиль", "app/profile/page.tsx", "Мой профиль"),
  entry("profile.description", "Описание профиля", "/profile", ".vates-personal-profile-heading > div > p", "Личные данные, обучение и настройки учетной записи.", "app/profile/page.tsx", "Личные данные, обучение и настройки учетной записи."),
  entry("learning.title", "Заголовок материалов", "/tasks", ".vates-education-screen > .vates-page-heading h1", "Материалы", "app/tasks/components/Education.tsx", ">Материалы</h1>"),
  entry("learning.urgentTitle", "Заголовок срочных заданий", "/tasks", ".vates-urgent-learning h2", "Срочно к прохождению", "app/tasks/components/Education.tsx", "Срочно к прохождению"),
  entry("learning.testsTitle", "Заголовок тестов", "/tasks", "#tests h2", "Тесты", "app/tasks/components/Education.tsx", 'id="tests"'),
  entry("learning.emptyTopics", "Пустой раздел материалов", "/tasks", "#topics .vates-material-section-empty strong", "Раздел пока пуст", "app/tasks/components/Education.tsx", "Раздел пока пуст"),
  entry("learning.emptyTests", "Пустой раздел тестов", "/tasks", "#tests .vates-material-section-empty strong", "Раздел пока пуст", "app/tasks/components/Education.tsx", "Раздел пока пуст")
];
const BY_ID = new Map(CATALOG.map((item) => [item.id, item]));
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
function demand(value) { if (!value) throw Error("INVALID_POINT_DESIGN"); }
function object(value, keys) { demand(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key))); }
function validatePointDesign(input) {
  object(input, ["format", "version", "clientId", "sourceRevision", "elements"]);
  demand(input.format === FORMAT && input.version === 3 && UUID.test(input.clientId) && REVISION.test(input.sourceRevision));
  object(input.elements, CATALOG.map((item) => item.id));
  const elements = {};
  for (const id of Object.keys(input.elements).sort()) {
    const value = input.elements[id], descriptor = BY_ID.get(id), next = {};
    object(value, ["text", "styles"]);
    if (value.text !== undefined) {
      demand(descriptor.text !== null && typeof value.text === "string" && value.text.trim() && value.text.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(value.text));
      next.text = value.text;
    }
    if (value.styles !== undefined) {
      object(value.styles, ["all", "light", "dark"]);
      const styles = {};
      for (const scope of ["all", "light", "dark"]) {
        if (!value.styles[scope]) continue;
        object(value.styles[scope], descriptor.properties);
        const properties = {};
        for (const key of descriptor.properties) {
          const property = value.styles[scope][key];
          if (property === undefined) continue;
          if (["color", "backgroundColor", "borderColor"].includes(key)) demand(typeof property === "string" && /^#[a-f0-9]{6}$/i.test(property));
          else if (key === "fontFamily") demand(typeof property === "string" && Object.values(FONTS).filter(Boolean).includes(property));
          else if (key === "fontSizePx") demand(Number.isInteger(property) && property >= 10 && property <= 64);
          else if (key === "fontWeight") demand([400, 500, 600, 700, 800, 900].includes(property));
          properties[key] = property;
        }
        if (Object.keys(properties).length) styles[scope] = properties;
      }
      if (Object.keys(styles).length) next.styles = styles;
    }
    if (Object.keys(next).length) elements[id] = next;
  }
  const normalized = { format: FORMAT, version: 3, clientId: input.clientId.toLowerCase(), sourceRevision: input.sourceRevision, elements };
  demand(Buffer.byteLength(JSON.stringify(normalized)) <= MAX_BYTES);
  return normalized;
}
const emptyPointDesign = (clientId, sourceRevision) => validatePointDesign({ format: FORMAT, version: 3, clientId, sourceRevision, elements: {} });
module.exports = { FORMAT, MAX_BYTES, CATALOG, FONTS, UUID, REVISION, validatePointDesign, emptyPointDesign };
