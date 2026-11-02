"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const ts = require("../../apps/control-center/node_modules/typescript");
const { validateClientDesign, designHash } = require("./client-design-contract.cjs");
const root = path.resolve(__dirname, "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function edits(source, changes) {
  const sorted = changes.sort((a, b) => b.start - a.start || b.end - a.end);
  let previous = source.length + 1;
  for (const change of sorted) {
    if (change.end > previous || change.start > change.end) throw Error("PRESENTATION_PATCH_OVERLAP");
    source = source.slice(0, change.start) + change.value + source.slice(change.end);
    previous = change.start;
  }
  return source;
}
function parse(source, name) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (file.parseDiagnostics.length || source.includes("useCoreClientDesign")) throw Error("UNSUPPORTED_PRESENTATION_SOURCE");
  return file;
}
function component(node) {
  let result;
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isFunctionDeclaration(cursor) && cursor.body && cursor.name && /^[A-Z]/.test(cursor.name.text)) result = cursor;
    if (ts.isArrowFunction(cursor) && ts.isBlock(cursor.body) && ts.isVariableDeclaration(cursor.parent) && ts.isIdentifier(cursor.parent.name) && /^[A-Z]/.test(cursor.parent.name.text)) result = cursor;
  }
  return result;
}
function importPosition(file) {
  return file.statements.filter(ts.isImportDeclaration).at(-1)?.end ?? file.statements[0]?.end ?? 0;
}

// This list is also enforced by CoreClientDesign; unknown editor IDs never become CSS selectors.
const SUPPORTED_ELEMENT_IDS = [
  "home.background", "home.badge", "home.title", "home.subtitle",
  "tasks.dashboardTitle", "tasks.dashboardCaption", "tasks.learningUrgentTitle", "tasks.learningUrgentEmptyText",
  "tasks.learningTheoryTitle", "tasks.learningTestsTitle", "tasks.learningEmptyTheoryText", "tasks.learningEmptyTestsText",
  "login.card", "login.title", "login.subtitle", "login.primaryAction",
  "admin.shell", "admin.title", "admin.subtitle", "admin.testResults",
  "profile.card", "profile.title", "profile.subtitle", "profile.name"
];
const ESSENTIAL_AUTH_IDS = new Set(["login.card", "login.primaryAction"]);
const AUTH_GEOMETRY_FIELDS = ["widthPercent", "marginTopPx", "marginBottomPx", "paddingPx", "offsetX", "offsetY"];
const DEFAULT_OVERRIDE = { visible: true, widthPercent: 100, marginTopPx: 0, marginBottomPx: 0, paddingPx: 0, offsetX: 0, offsetY: 0, align: "center", backgroundColor: "", textColor: "", borderColor: "" };

function opening(node) {
  return ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
}
function attribute(node, name) {
  return opening(node)?.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText() === name);
}
function hasClass(node, name) {
  const value = attribute(node, "className")?.initializer;
  return !!value && ts.isStringLiteral(value) && value.text.split(/\s+/).includes(name);
}
function insideClass(node, name) {
  for (let parent = node.parent; parent; parent = parent.parent) if (hasClass(parent, name)) return true;
  return false;
}
function insideSection(node, id) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    const value = attribute(parent, "id")?.initializer;
    if (opening(parent)?.tagName.getText() === "section" && value && ts.isStringLiteral(value) && value.text === id) return true;
  }
  return false;
}
function handles(node, name) {
  const value = attribute(node, "onClick")?.initializer;
  return !!value && ts.isJsxExpression(value) && !!value.expression && ts.isIdentifier(value.expression) && value.expression.text === name;
}
function spreadsStyle(node, name) {
  const value = attribute(node, "style")?.initializer;
  return !!value && ts.isJsxExpression(value) && !!value.expression && ts.isObjectLiteralExpression(value.expression) && value.expression.properties.some((item) => ts.isSpreadAssignment(item) && ts.isIdentifier(item.expression) && item.expression.text === name);
}
function insideAuthModal(node) {
  for (let parent = node.parent; parent; parent = parent.parent) if (hasClass(parent, "modal-content-custom") && spreadsStyle(parent, "modalContent")) return true;
  return false;
}
function containsText(node, text) {
  return ts.isJsxElement(node) && node.children.some((child) => ts.isJsxText(child) && child.text.trim() === text);
}
const anchor = (id, tag, matches, count = 1) => ({ id, tag, matches, count });
const classAnchor = (id, tag, name) => anchor(id, tag, (node) => hasClass(node, name));
const textAnchor = (id, tag, text, count = 1) => anchor(id, tag, (node) => containsText(node, text), count);
const elementRules = {
  "app/login/page.tsx": [
    classAnchor("home.background", "section", "vates-auth-story"),
    classAnchor("home.badge", "span", "login-card-eyebrow"),
    anchor("home.title", "h1", (node) => insideClass(node, "vates-auth-message")),
    anchor("home.subtitle", "p", (node) => insideClass(node, "vates-auth-message")),
    classAnchor("login.card", "div", "login-box"),
    anchor("login.title", "h1", (node) => insideClass(node, "login-card-heading")),
    anchor("login.subtitle", "p", (node) => insideClass(node, "login-card-heading")),
    anchor("login.primaryAction", "button", (node) => handles(node, "handleLogin")),
    anchor("login.primaryAction", "button", (node) => handles(node, "handleRegister"))
  ],
  "app/components/Navigation.tsx": [
    anchor("login.card", "div", (node) => hasClass(node, "modal-content-custom") && spreadsStyle(node, "modalContent")),
    anchor("login.title", "h2", (node) => insideAuthModal(node)),
    anchor("login.primaryAction", "div", (node) => handles(node, "handleLogin")),
    anchor("login.primaryAction", "div", (node) => handles(node, "handleRegister"))
  ],
  "app/tasks/page.tsx": [
    textAnchor("tasks.dashboardTitle", "h1", "Моё обучение"),
    textAnchor("tasks.dashboardCaption", "p", "Ваш прогресс, обязательные материалы и ближайшие учебные шаги.")
  ],
  "app/tasks/components/Education.tsx": [
    textAnchor("tasks.learningTheoryTitle", "h1", "Материалы"),
    textAnchor("tasks.learningUrgentTitle", "h2", "Срочно к прохождению"),
    anchor("tasks.learningUrgentEmptyText", "div", (node) => insideClass(node, "vates-urgent-learning") && containsText(node, "У вас нет срочных заданий.")),
    anchor("tasks.learningTestsTitle", "h2", (node) => insideSection(node, "tests") && containsText(node, "Тесты")),
    anchor("tasks.learningEmptyTheoryText", "strong", (node) => insideSection(node, "topics") && insideClass(node, "vates-material-section-empty") && containsText(node, "Раздел пока пуст")),
    anchor("tasks.learningEmptyTestsText", "strong", (node) => insideSection(node, "tests") && insideClass(node, "vates-material-section-empty") && containsText(node, "Раздел пока пуст"))
  ],
  "app/admin/page.tsx": [classAnchor("admin.shell", "main", "admin-main")],
  "app/admin/components/VatesAdminOverview.tsx": [
    textAnchor("admin.title", "h1", "Рабочее пространство"),
    textAnchor("admin.subtitle", "p", "Сводка по сотрудникам, учебным материалам и результатам.")
  ],
  "app/admin/components/TestResultsModal.tsx": [classAnchor("admin.testResults", "section", "vates-test-results-modal")],
  "app/profile/page.tsx": [
    classAnchor("profile.card", "section", "vates-profile-person-card"),
    anchor("profile.title", "h1", (node) => insideClass(node, "vates-personal-profile-heading")),
    anchor("profile.subtitle", "p", (node) => insideClass(node, "vates-personal-profile-heading")),
    anchor("profile.name", "h3", (node) => insideClass(node, "vates-profile-person-copy"))
  ]
};

function patchElements(source, name) {
  const file = parse(source, name), changes = [], counts = new Map(), ids = new Set();
  const fields = elementRules[name];
  if (!fields || /data-core-(?:element|text)/.test(source)) throw Error(`UNSUPPORTED_PRESENTATION_ELEMENTS:${name}`);
  let sectionLabels = 0, accessibleSectionLabels = 0;
  const sectionDisplay = '(secName === "Основной раздел" ? (coreDesign?.content["learningDefaultSectionLabel"] ?? secName) : secName)';
  const visit = (node) => {
    const tag = opening(node);
    if (tag) {
      const matches = fields.filter((rule) => tag.tagName.getText(file) === rule.tag && rule.matches(node));
      if (matches.length > 1) throw Error(`AMBIGUOUS_PRESENTATION_ELEMENT:${name}`);
      for (const rule of matches) {
        changes.push({ start: tag.tagName.end, end: tag.tagName.end, value: ` data-core-element=${JSON.stringify(rule.id)}` });
        counts.set(rule, (counts.get(rule) || 0) + 1); ids.add(rule.id);
      }
    }
    // Only the two rendered captions and their accessible names change. Group keys,
    // saved section values, collapse keys and onToggle callbacks remain byte-for-byte intact.
    if (name === "app/tasks/components/Education.tsx" && ts.isJsxExpression(node) && node.expression && ts.isIdentifier(node.expression) && node.expression.text === "secName") {
      const parent = node.parent;
      const isHeading = ts.isJsxElement(parent) && parent.openingElement.tagName.getText(file) === "h3" && hasClass(parent.parent, "section-header-row");
      if (isHeading && (insideSection(node, "topics") || insideSection(node, "tests"))) {
        changes.push({ start: node.expression.getStart(file), end: node.expression.end, value: sectionDisplay });
        changes.push({ start: parent.openingElement.tagName.end, end: parent.openingElement.tagName.end, value: ' data-core-text={secName === "Основной раздел" ? "learningDefaultSectionLabel" : undefined}' });
        sectionLabels++;
      }
      if (ts.isJsxAttribute(parent) && parent.name.getText(file) === "sectionName" && opening(parent.parent.parent)?.tagName.getText(file) === "SectionCollapseButton" && (insideSection(node, "topics") || insideSection(node, "tests"))) {
        changes.push({ start: node.expression.getStart(file), end: node.expression.end, value: sectionDisplay });
        accessibleSectionLabels++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const rule of fields) if ((counts.get(rule) || 0) !== rule.count) throw Error(`UNSUPPORTED_PRESENTATION_ELEMENT_COUNT:${name}:${rule.id}`);
  if (name === "app/tasks/components/Education.tsx" && (sectionLabels !== 2 || accessibleSectionLabels !== 2)) throw Error("UNSUPPORTED_PRESENTATION_SECTION_LABELS");
  return { source: edits(source, changes), ids: [...ids], used: sectionLabels ? ["learningDefaultSectionLabel"] : [] };
}

function patchTexts(source, name, rules) {
  const file = parse(source, name), changes = [], owners = new Set(), used = new Set(), counts = new Map();
  const visit = (node) => {
    const jsxText = ts.isJsxText(node);
    const literal = ts.isStringLiteral(node);
    if (jsxText || literal) {
      const value = jsxText ? node.text.trim() : node.text;
      for (const rule of rules) {
        if (value !== rule.text || (rule.kind === "jsx" && !jsxText) || (rule.kind === "literal" && !literal)) continue;
        if (rule.elementId) {
          const id = attribute(node.parent, "data-core-element")?.initializer;
          if (!id || !ts.isStringLiteral(id) || id.text !== rule.elementId) continue;
        }
        if (literal) {
          let jsxParent = false;
          for (let cursor = node.parent; cursor && !ts.isFunctionDeclaration(cursor); cursor = cursor.parent) if (ts.isJsxExpression(cursor)) { jsxParent = true; break; }
          const label = ts.isPropertyAssignment(node.parent) && node.parent.name.getText(file) === "label";
          if (!jsxParent && !label) continue;
        }
        const owner = component(node);
        if (!owner) continue;
        const count = counts.get(rule) || 0;
        const key = Array.isArray(rule.key) ? rule.key[count] : rule.key;
        if (!key) throw Error("UNSUPPORTED_PRESENTATION_TEXT_COUNT");
        const fallback = JSON.stringify(rule.fallback ?? value);
        const expression = `coreDesign?.content[${JSON.stringify(key)}] ?? ${fallback}`;
        const prefix = rule.prefix ? `{${JSON.stringify(rule.prefix)}}` : "";
        changes.push({ start: node.getStart(file), end: node.end, value: jsxText ? `${prefix}{${expression}}` : `(${expression})` });
        if (rule.textAttribute && jsxText && ts.isJsxElement(node.parent)) {
          const tag = node.parent.openingElement;
          changes.push({ start: tag.tagName.end, end: tag.tagName.end, value: ` data-core-text=${JSON.stringify(key)}` });
        }
        owners.add(owner); used.add(key); counts.set(rule, count + 1);
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const rule of rules) {
    const count = counts.get(rule) || 0;
    if (count < (rule.minimum || 0) || (rule.exact !== undefined && count !== rule.exact)) throw Error(`UNSUPPORTED_PRESENTATION_CONTRACT:${name}:${rule.key}`);
  }
  if (!changes.length) throw Error(`UNSUPPORTED_PRESENTATION_COMPONENT:${name}`);
  for (const owner of owners) changes.push({ start: owner.body.getStart(file) + 1, end: owner.body.getStart(file) + 1, value: "\n  const coreDesign = useCoreClientDesign();\n" });
  changes.push({ start: importPosition(file), end: importPosition(file), value: '\nimport { useCoreClientDesign } from "@/app/components/CoreClientDesign";\n' });
  return { source: edits(source, changes), used: [...used] };
}
function patchLayout(source) {
  const file = parse(source, "layout.tsx"), changes = [];
  let provider = 0, html = 0;
  const visit = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "ThemeProvider") {
      provider++;
      changes.push({ start: node.openingElement.end, end: node.openingElement.end, value: "<CoreClientDesign design={coreDesign}>" });
      changes.push({ start: node.closingElement.getStart(file), end: node.closingElement.getStart(file), value: "</CoreClientDesign>" });
    }
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(file) === "html") {
      html++;
      changes.push({ start: node.tagName.end, end: node.tagName.end, value: ' data-core-design={coreDesign ? "true" : undefined}' });
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "title" && ts.isStringLiteral(node.initializer) && node.initializer.text === "Ватэс") changes.push({ start: node.initializer.getStart(file), end: node.initializer.end, value: '(coreDesign?.brandName || "Ватэс")' });
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (provider !== 1 || html !== 1) throw Error("UNSUPPORTED_PRESENTATION_LAYOUT");
  changes.push({ start: importPosition(file), end: importPosition(file), value: '\nimport CoreClientDesign from "./components/CoreClientDesign";\nimport { readCoreClientDesign } from "./lib/coreClientDesignServer";\nconst coreDesign = readCoreClientDesign();\n' });
  return edits(source, changes);
}
function patchLogo(source) {
  const file = parse(source, "VatesLogo.tsx");
  const fn = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "VatesLogo" && node.body);
  if (!fn || !source.includes("variant === 'symbol'")) throw Error("UNSUPPORTED_PRESENTATION_LOGO");
  return edits(source, [
    { start: 0, end: 0, value: '"use client";\n' },
    { start: importPosition(file), end: importPosition(file), value: '\nimport { useCoreClientDesign } from "./CoreClientDesign";\n' },
    { start: fn.body.getStart(file) + 1, end: fn.body.getStart(file) + 1, value: '\n const coreDesign = useCoreClientDesign();\n if (coreDesign) return <span className={`core-client-brand ${className}`} aria-label={coreDesign.brandName}>{variant === "symbol" ? coreDesign.brandName.slice(0, 1) : coreDesign.brandName}</span>;\n' }
  ]);
}
const jsx = (text, key, exact = 1) => ({ kind: "jsx", text, key, minimum: exact, exact });
const literal = (text, key, exact = 1) => ({ kind: "literal", text, key, minimum: exact, exact });
const rules = {
  "app/login/page.tsx": [jsx("Обучение команды — под вашим контролем.", "homeTitle"), jsx("Отслеживайте прохождение, ответы и пробелы в знаниях, чтобы вовремя подключать наставника и принимать решения на фактах.", "homeSubtitle"), literal("Личный кабинет", "homeBadge"), literal("Вход в Ватэс", "loginTitle"), literal("Введите данные, чтобы продолжить обучение.", "loginSubtitle"), jsx("ВОЙТИ", "loginButtonLabel"), jsx("ЗАРЕГИСТРИРОВАТЬСЯ", "registerButtonLabel"), { ...jsx("← НА ГЛАВНУЮ", "navHomeLabel"), prefix: "← ", fallback: "НА ГЛАВНУЮ", textAttribute: true }],
  "app/components/Navigation.tsx": [literal("Рабочее пространство", "navAdminLabel"), literal("Мой прогресс", "navTasksLabel"), literal("Войти в аккаунт", "loginTitle"), jsx("Войти", "loginButtonLabel", 2), { ...jsx("Отмена", "cancelLabel"), textAttribute: true }, { ...jsx("Мой Профиль", "navProfileLabel"), textAttribute: true }],
  "app/profile/page.tsx": [jsx("Мой профиль", "profileTitle", 2), jsx("Личные данные, обучение и настройки учетной записи.", "profileSubtitle")],
  "app/tasks/page.tsx": [jsx("Моё обучение", "tasksDashboardTitle"), jsx("Ваш прогресс, обязательные материалы и ближайшие учебные шаги.", "tasksDashboardCaption")],
  "app/admin/components/VatesAdminOverview.tsx": [jsx("Рабочее пространство", "adminTitle"), jsx("Сводка по сотрудникам, учебным материалам и результатам.", "adminSubtitle")],
  "app/tasks/components/Education.tsx": [jsx("Материалы", "learningTheoryTitle"), jsx("Срочно к прохождению", "learningUrgentTitle"), jsx("У вас нет срочных заданий.", "learningUrgentEmptyText"), jsx("Тесты", "learningTestsTitle"), { ...jsx("Раздел пока пуст", "learningEmptyTheoryText"), elementId: "tasks.learningEmptyTheoryText" }, { ...jsx("Раздел пока пуст", "learningEmptyTestsText"), elementId: "tasks.learningEmptyTestsText" }]
};

function presentationSupport(design, supportedTextKeys, supportedElementIds) {
  const supportedSettings = new Set(["brandName", ...Object.keys(design.theme).map((key) => `theme.${key}`), ...Object.keys(design.typography).map((key) => `typography.${key}`), ...supportedTextKeys.map((key) => `content.${key}`)]);
  const unsupportedSettings = new Set(), warnings = [];
  const unsupported = (setting, value, defaultValue, message) => {
    unsupportedSettings.add(setting);
    if (JSON.stringify(value) !== JSON.stringify(defaultValue)) warnings.push({ setting, code: "UNSUPPORTED_SETTING_IGNORED", message });
  };
  unsupported("content.primaryCtaLabel", design.content.primaryCtaLabel, "Начать обучение", "The accepted UI has no home CTA; the saved label is retained but not applied.");
  unsupported("content.learningRoleTrackLabel", design.content.learningRoleTrackLabel, "", "The accepted UI has no starting-role block; the saved label is retained but not applied.");
  if (design.version === 2) {
    for (const setting of ["content.homeBackgroundImageUrl", "layout.density", "layout.cardRadiusPx", "layout.sectionGapPx", "components.buttonShadow", "components.smoothTabs", "elementOverrides"]) supportedSettings.add(setting);
    for (const key of ["homeFeatureCards", "learningRoleTrackItems"]) unsupported(`content.${key}`, design.content[key], [], "No corresponding accepted UI block exists; saved items are retained without creating content.");
    const defaults = { homeCtaOffsetX: 0, homeCtaOffsetY: 0, homeCtaAlign: "center", homeSectionOrder: ["hero", "features"], homeFeatureCardOrder: [0, 1, 2] };
    for (const [key, value] of Object.entries(defaults)) unsupported(`layout.${key}`, design.layout[key], value, "The accepted UI has no home CTA/feature-card layout; this option is not applied.");
    unsupported("components.showHomeCta", design.components.showHomeCta, false, "No CTA is created in the accepted UI.");
    for (const [id, override] of Object.entries(design.elementOverrides)) {
      if (!supportedElementIds.includes(id)) {
        unsupported(`elementOverrides.${id}`, override, DEFAULT_OVERRIDE, "This semantic element is absent or not allowlisted; its override is ignored.");
        continue;
      }
      if (ESSENTIAL_AUTH_IDS.has(id)) {
        if (!override.visible) {
          const setting = `elementOverrides.${id}.visible`;
          unsupportedSettings.add(setting);
          warnings.push({ setting, code: "ESSENTIAL_AUTH_HIDE_IGNORED", message: "The sign-in form and its primary action must remain usable; hiding is ignored." });
        }
        for (const key of AUTH_GEOMETRY_FIELDS) unsupported(`elementOverrides.${id}.${key}`, override[key], DEFAULT_OVERRIDE[key], "Geometry overrides are ignored for essential auth elements so the form/action cannot be moved out of reach.");
      }
    }
  }
  return { supportedElementIds: [...supportedElementIds].sort(), supportedSettings: [...supportedSettings].sort(), unsupportedSettings: [...unsupportedSettings].sort(), warnings };
}

async function applyPresentation(directory, input) {
  const design = validateClientDesign(input), modifiedFiles = [], supportedTextKeys = new Set(), supportedElementIds = new Set(), staged = new Map();
  const patch = async (relative, transform) => {
    const file = path.join(directory, relative), before = await fs.readFile(file, "utf8");
    const after = transform(before);
    const parsed = ts.createSourceFile(relative, after, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (parsed.parseDiagnostics.length) throw Error(`PRESENTATION_SYNTAX_FAILED:${relative}`);
    staged.set(file, after);
    modifiedFiles.push({ path: relative, beforeSha256: hash(before), afterSha256: hash(after) });
  };
  await patch("app/layout.tsx", patchLayout);
  await patch("app/components/VatesLogo.tsx", patchLogo);
  // Validate every source anchor before writing the package copy. The accepted snapshot is never edited here.
  for (const relative of Object.keys(elementRules)) await patch(relative, (source) => {
    const elements = patchElements(source, relative);
    elements.ids.forEach((id) => supportedElementIds.add(id));
    elements.used.forEach((key) => supportedTextKeys.add(key));
    if (!rules[relative]) return elements.source;
    const result = patchTexts(elements.source, relative, rules[relative]);
    result.used.forEach((key) => supportedTextKeys.add(key));
    return result.source;
  });
  if (SUPPORTED_ELEMENT_IDS.some((id) => !supportedElementIds.has(id)) || supportedElementIds.size !== SUPPORTED_ELEMENT_IDS.length) throw Error("UNSUPPORTED_PRESENTATION_ELEMENT_MANIFEST");
  const support = presentationSupport(design, [...supportedTextKeys], [...supportedElementIds]);
  for (const [file, source] of staged) await fs.writeFile(file, source);
  for (const [source, destination] of [["infra/lms-adapter/CoreClientDesign.tsx", "app/components/CoreClientDesign.tsx"], ["infra/lms-adapter/coreClientDesignServer.ts", "app/lib/coreClientDesignServer.ts"], ["infra/scripts/client-design-contract.cjs", "core-client-design-contract.cjs"]]) {
    await fs.writeFile(path.join(directory, destination), await fs.readFile(path.join(root, source)), { flag: "wx" });
  }
  await fs.writeFile(path.join(directory, "core-client-design.json"), JSON.stringify(design), { flag: "wx" });
  // Assets are verified/copied by the parent package builder, not by this adapter.
  return { version: design.version, clientId: design.clientId, sha256: designHash(design), supportedTextKeys: [...supportedTextKeys].sort(), ...support, modifiedFiles };
}
module.exports = { applyPresentation, patchTexts, patchElements, patchLayout, patchLogo, presentationSupport, SUPPORTED_ELEMENT_IDS };
