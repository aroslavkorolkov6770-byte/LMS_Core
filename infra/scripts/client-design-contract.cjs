"use strict";
const { createHash } = require("node:crypto");
const FORMAT = "lms-client-design-v1";
const FORMAT_V2 = "lms-client-design-v2";
const MAX_BYTES = 1024 * 1024;
const THEME_KEYS = ["primary", "accent", "background", "surface", "button", "buttonText", "text", "muted", "border", "success", "danger"];
const TEXT_KEYS = ["homeBadge", "homeTitle", "homeSubtitle", "primaryCtaLabel", "loginTitle", "loginSubtitle", "loginButtonLabel", "registerButtonLabel", "cancelLabel", "tasksDashboardTitle", "tasksDashboardCaption", "learningRoleTrackLabel", "learningUrgentTitle", "learningUrgentEmptyText", "learningTheoryTitle", "learningTestsTitle", "learningDefaultSectionLabel", "learningEmptyTheoryText", "learningEmptyTestsText", "adminTitle", "adminSubtitle", "profileTitle", "profileSubtitle", "navHomeLabel", "navTasksLabel", "navAdminLabel", "navProfileLabel"];
const FONT_KEYS = ["headingFont", "bodyFont", "buttonFont"];
const NUMBER_RANGES = { baseFontSizePx: [8, 48], headingScale: [0.5, 3], buttonFontSizePx: [8, 48], buttonRadiusPx: [0, 999], navFontSizePx: [8, 40] };
function demand(value) { if (!value) throw Error("INVALID_CLIENT_DESIGN"); }
function text(value, max, empty = true) {
  demand(typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && (empty || value.trim()));
  return value;
}
function color(value) {
  text(value, 100, false);
  if (/^#(?:[a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(value) || /^(?:transparent|black|white|red|green|blue|gray|grey|orange|yellow|teal|navy|currentColor)$/i.test(value)) return value;
  const rgb = /^(rgb|rgba)\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?|\.\d+))?\s*\)$/.exec(value);
  demand(rgb && rgb.slice(2, 5).every((item) => Number(item) >= 0 && Number(item) <= 255) && (rgb[1] === "rgb" ? rgb[5] === undefined : rgb[5] !== undefined && Number(rgb[5]) >= 0 && Number(rgb[5]) <= 1));
  return value;
}
function number(value, minimum, maximum) { demand(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum); return value; }
function boolean(value) { demand(typeof value === "boolean"); return value; }
function choice(value, choices) { demand(choices.includes(value)); return value; }
function assets(input) {
  demand(Array.isArray(input) && input.length <= 4);
  const seen = new Set();
  return input.map((item) => {
    demand(item && /^core-branding\/([a-f0-9]{64})\.(png|jpg|webp)$/.test(item.path) && /^[a-f0-9]{64}$/.test(item.sha256) && item.path.split("/")[1].split(".")[0] === item.sha256 && !seen.has(item.path));
    seen.add(item.path);
    const extension = item.path.split(".").at(-1);
    demand(item.mime === { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[extension]);
    return { path: item.path, sha256: item.sha256, bytes: number(item.bytes, 24, 4 * 1024 * 1024), mime: item.mime };
  });
}
function createClientDesign(input) {
  demand(input && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.clientId));
  const settings = input.settings;
  demand(settings && settings.version === 1 && settings.theme && settings.typography && settings.content);
  const theme = Object.fromEntries(THEME_KEYS.map((key) => [key, color(settings.theme[key])]));
  const typography = {};
  for (const key of FONT_KEYS) {
    const value = text(settings.typography[key], 160, false);
    demand(/^(?:[a-z_][a-z0-9 _-]*|"[a-z0-9 _-]+"|'[a-z0-9 _-]+')(?:\s*,\s*(?:[a-z_][a-z0-9 _-]*|"[a-z0-9 _-]+"|'[a-z0-9 _-]+'))*$/i.test(value));
    typography[key] = value;
  }
  for (const [key, [minimum, maximum]] of Object.entries(NUMBER_RANGES)) {
    const value = settings.typography[key];
    demand(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum);
    typography[key] = value;
  }
  const content = Object.fromEntries(TEXT_KEYS.map((key) => [key, text(settings.content[key], 20000)]));
  const version = input.version ?? 2;
  demand([1, 2].includes(version));
  const design = { format: version === 1 ? FORMAT : FORMAT_V2, version, clientId: input.clientId.toLowerCase(), brandName: text(input.brandName, 200, false), theme, typography, content };
  if (version === 2) {
    const projectedAssets = assets(input.assets || []), imageUrl = input.imageUrl || "";
    demand(imageUrl === "" || projectedAssets.some((asset) => `/${asset.path}` === imageUrl));
    content.homeBackgroundImageUrl = imageUrl;
    demand(Array.isArray(settings.content.homeFeatureCards) && settings.content.homeFeatureCards.length <= 12 && Array.isArray(settings.content.learningRoleTrackItems) && settings.content.learningRoleTrackItems.length <= 20);
    content.homeFeatureCards = settings.content.homeFeatureCards.map((item) => ({ title: text(item.title, 2000), desc: text(item.desc, 10000) }));
    content.learningRoleTrackItems = settings.content.learningRoleTrackItems.map((item) => text(item, 2000));
    const layout = settings.layout, components = settings.components;
    demand(layout && components && Array.isArray(layout.homeSectionOrder) && layout.homeSectionOrder.length === 2 && new Set(layout.homeSectionOrder).size === 2 && layout.homeSectionOrder.every((item) => ["hero", "features"].includes(item)));
    demand(Array.isArray(layout.homeFeatureCardOrder) && layout.homeFeatureCardOrder.length <= 12 && new Set(layout.homeFeatureCardOrder).size === layout.homeFeatureCardOrder.length && layout.homeFeatureCardOrder.every((item) => Number.isInteger(item) && item >= 0 && item < 12));
    design.layout = { density: choice(layout.density, ["compact", "normal", "spacious"]), cardRadiusPx: number(layout.cardRadiusPx, 0, 128), sectionGapPx: number(layout.sectionGapPx, 0, 200), homeCtaOffsetX: number(layout.homeCtaOffsetX, -1000, 1000), homeCtaOffsetY: number(layout.homeCtaOffsetY, -1000, 1000), homeCtaAlign: choice(layout.homeCtaAlign, ["left", "center", "right"]), homeSectionOrder: [...layout.homeSectionOrder], homeFeatureCardOrder: [...layout.homeFeatureCardOrder] };
    design.components = { showHomeCta: boolean(components.showHomeCta), smoothTabs: boolean(components.smoothTabs), buttonShadow: boolean(components.buttonShadow) };
    demand(settings.elementOverrides && typeof settings.elementOverrides === "object" && !Array.isArray(settings.elementOverrides) && Object.keys(settings.elementOverrides).length <= 256);
    design.elementOverrides = Object.fromEntries(Object.entries(settings.elementOverrides).sort(([a], [b]) => a.localeCompare(b, "en")).map(([id, value]) => {
      demand(/^[a-z][a-z0-9_.:-]{0,100}$/i.test(id) && value);
      return [id, { visible: boolean(value.visible), widthPercent: number(value.widthPercent, 10, 100), marginTopPx: number(value.marginTopPx, -500, 500), marginBottomPx: number(value.marginBottomPx, -500, 500), paddingPx: number(value.paddingPx, 0, 200), offsetX: number(value.offsetX, -1000, 1000), offsetY: number(value.offsetY, -1000, 1000), align: choice(value.align, ["left", "center", "right"]), backgroundColor: value.backgroundColor === "" ? "" : color(value.backgroundColor), textColor: value.textColor === "" ? "" : color(value.textColor), borderColor: value.borderColor === "" ? "" : color(value.borderColor) }];
    }));
    design.assets = projectedAssets;
  }
  demand(Buffer.byteLength(JSON.stringify(design)) <= MAX_BYTES);
  return design;
}
function validateClientDesign(value) {
  if (value?.version === 3) {
    const normalized = require("./point-design-contract.cjs").validatePointDesign(value);
    demand(JSON.stringify(value) === JSON.stringify(normalized));
    return normalized;
  }
  demand(value && (value.version === 1 && value.format === FORMAT || value.version === 2 && value.format === FORMAT_V2));
  const normalized = createClientDesign({ version: value.version, clientId: value.clientId, brandName: value.brandName, imageUrl: value.content?.homeBackgroundImageUrl, assets: value.assets, settings: { version: 1, theme: value.theme, typography: value.typography, content: value.content, layout: value.layout, components: value.components, elementOverrides: value.elementOverrides } });
  demand(JSON.stringify(value) === JSON.stringify(normalized));
  return normalized;
}
const designHash = (value) => createHash("sha256").update(JSON.stringify(validateClientDesign(value))).digest("hex");
module.exports = { FORMAT, FORMAT_V2, MAX_BYTES, THEME_KEYS, TEXT_KEYS, FONT_KEYS, NUMBER_RANGES, createClientDesign, validateClientDesign, designHash };
