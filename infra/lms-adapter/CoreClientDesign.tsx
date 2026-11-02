"use client";

import { createContext, useContext } from "react";

type CoreTextKey =
  | "homeBadge" | "homeTitle" | "homeSubtitle" | "primaryCtaLabel"
  | "loginTitle" | "loginSubtitle" | "loginButtonLabel" | "registerButtonLabel" | "cancelLabel"
  | "tasksDashboardTitle" | "tasksDashboardCaption" | "learningRoleTrackLabel"
  | "learningUrgentTitle" | "learningUrgentEmptyText" | "learningTheoryTitle" | "learningTestsTitle"
  | "learningDefaultSectionLabel" | "learningEmptyTheoryText" | "learningEmptyTestsText"
  | "adminTitle" | "adminSubtitle" | "profileTitle" | "profileSubtitle"
  | "navHomeLabel" | "navTasksLabel" | "navAdminLabel" | "navProfileLabel";

type CoreContent = Record<CoreTextKey, string> & {
  homeBackgroundImageUrl?: string;
  homeFeatureCards?: Array<{ title: string; desc: string }>;
  learningRoleTrackItems?: string[];
};

export type CoreElementOverride = {
  visible: boolean;
  widthPercent: number;
  marginTopPx: number;
  marginBottomPx: number;
  paddingPx: number;
  offsetX: number;
  offsetY: number;
  align: "left" | "center" | "right";
  backgroundColor: string;
  textColor: string;
  borderColor: string;
};

type CoreDesignBase = {
  clientId: string;
  brandName: string;
  theme: Record<string, string>;
  typography: { headingFont: string; bodyFont: string; buttonFont: string; baseFontSizePx: number; headingScale: number; buttonFontSizePx: number; buttonRadiusPx: number; navFontSizePx: number };
  content: CoreContent;
};

export type CoreDesign = CoreDesignBase & (
  { format: "lms-client-design-v1"; version: 1 } |
  {
    format: "lms-client-design-v2";
    version: 2;
    layout: {
      density: "compact" | "normal" | "spacious";
      cardRadiusPx: number;
      sectionGapPx: number;
      homeCtaOffsetX: number;
      homeCtaOffsetY: number;
      homeCtaAlign: "left" | "center" | "right";
      homeSectionOrder: Array<"hero" | "features">;
      homeFeatureCardOrder: number[];
    };
    components: { showHomeCta: boolean; smoothTabs: boolean; buttonShadow: boolean };
    elementOverrides: Record<string, CoreElementOverride>;
    assets: Array<{ path: string; sha256: string; bytes: number; mime: string }>;
  }
);

// Keep this allowlist in sync with the adapter's checked AST anchors. IDs from a
// saved document must never be interpolated into arbitrary CSS selectors.
export const CORE_DESIGN_ELEMENT_IDS = [
  "home.background", "home.badge", "home.title", "home.subtitle",
  "tasks.dashboardTitle", "tasks.dashboardCaption", "tasks.learningUrgentTitle", "tasks.learningUrgentEmptyText",
  "tasks.learningTheoryTitle", "tasks.learningTestsTitle", "tasks.learningEmptyTheoryText", "tasks.learningEmptyTestsText",
  "login.card", "login.title", "login.subtitle", "login.primaryAction",
  "admin.shell", "admin.title", "admin.subtitle", "admin.testResults",
  "profile.card", "profile.title", "profile.subtitle", "profile.name"
] as const;

const ESSENTIAL_AUTH_IDS = new Set<string>(["login.card", "login.primaryAction"]);
const SCOPE = "html:root[data-core-design]";
const elementSelector = (id: string) => `${SCOPE} [data-core-element="${id}"]`;

function elementOverrideCss(id: string, override: CoreElementOverride): string {
  const declarations: string[] = [];
  const essential = ESSENTIAL_AUTH_IDS.has(id);
  if (!essential) {
    if (!override.visible) declarations.push("display:none!important");
    if (override.widthPercent !== 100) declarations.push(`width:${override.widthPercent}%!important`);
    if (override.marginTopPx !== 0) declarations.push(`margin-top:${override.marginTopPx}px!important`);
    if (override.marginBottomPx !== 0) declarations.push(`margin-bottom:${override.marginBottomPx}px!important`);
    if (override.paddingPx !== 0) declarations.push(`padding:${override.paddingPx}px!important`);
    // Independent translate composes with existing transform/keyframe animations.
    if (override.offsetX !== 0 || override.offsetY !== 0) declarations.push(`translate:${override.offsetX}px ${override.offsetY}px!important`);
    if (override.align === "left") declarations.push("text-align:left!important", "margin-left:0!important", "margin-right:auto!important");
    if (override.align === "right") declarations.push("text-align:right!important", "margin-left:auto!important", "margin-right:0!important");
    if (override.align === "center" && override.widthPercent !== 100) declarations.push("text-align:center!important", "margin-left:auto!important", "margin-right:auto!important");
  } else {
    // Saved geometry/hiding cannot strand a sign-in action outside the viewport.
    // The package manifest reports every non-default value ignored here.
    if (override.align !== "center") declarations.push(`text-align:${override.align}!important`);
  }
  if (override.backgroundColor) declarations.push(`background-color:${override.backgroundColor}!important`);
  if (override.textColor) declarations.push(`color:${override.textColor}!important`);
  if (override.borderColor) declarations.push(`border:1px solid ${override.borderColor}!important`);
  return declarations.length ? `${elementSelector(id)}{${declarations.join(";")};}` : "";
}

export function coreDesignV2Css(design: CoreDesign): string {
  if (design.version !== 2) return "";
  const { layout, components } = design;
  const densityPadding = { compact: 16, normal: 24, spacious: 32 }[layout.density];
  const cardSelectors = ["login.card", "profile.card", "admin.testResults"].map(elementSelector);
  cardSelectors.push(`${SCOPE} .vates-education-screen .vates-material-card`);
  const gapSelectors = [".vates-profile-top-grid", ".vates-profile-content-grid", ".vates-education-screen .vates-material-groups", ".vates-education-screen .vates-material-card-grid"].map((selector) => `${SCOPE} ${selector}`);
  const buttonSelectors = ["button[data-core-element=\"login.primaryAction\"]", ".vates-app-page button.vates-button", ".guest-header button.vates-button"].map((selector) => `${SCOPE} ${selector}:not(:focus-visible)`);
  // These are existing screen/nav selectors, not a new tab system. True only
  // adjusts existing motion; false and reduced-motion disable it in this scope.
  const screenSelectors = [".tasks-main .vates-staff-dashboard", ".tasks-main .vates-education-screen", ".admin-main .vates-admin-overview", ".vates-personal-profile-main .vates-personal-profile-content"].map((selector) => `${SCOPE} ${selector}`).join(",");
  const navSelectors = [".vates-sidebar-nav a.nav-item", ".vates-bottom-nav a.vates-bottom-nav-item", ".vates-mobile-nav-sheet a.vates-mobile-nav-sheet-item"].map((selector) => `${SCOPE} ${selector}`).join(",");
  let css = `
    ${SCOPE}{--core-card-radius:${layout.cardRadiusPx}px;--core-section-gap:${layout.sectionGapPx}px;--core-density-padding:${densityPadding}px;}
    ${cardSelectors.join(",")}{border-radius:var(--core-card-radius)!important;padding:var(--core-density-padding)!important;}
    ${gapSelectors.join(",")}{gap:var(--core-section-gap)!important;}
    ${buttonSelectors.join(",")}{box-shadow:${components.buttonShadow ? "0 8px 22px color-mix(in srgb,var(--app-accent) 20%,transparent)" : "none"}!important;}
    ${screenSelectors}{${components.smoothTabs ? "animation-duration:240ms!important;animation-timing-function:ease-out!important;" : "animation:none!important;transition-duration:0s!important;"}}
    ${navSelectors}{transition-duration:${components.smoothTabs ? "160ms" : "0s"}!important;}
    @media(prefers-reduced-motion:reduce){${screenSelectors},${navSelectors}{animation:none!important;transition-duration:0s!important;}}
  `;
  const image = design.content.homeBackgroundImageUrl;
  if (image && /^\/core-branding\/[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(image) && design.assets.some((asset) => `/${asset.path}` === image)) {
    // The parent builder owns asset bytes/hash verification. Only its portable
    // local URL is used here; the old hidden background is never made visible.
    css += `${elementSelector("home.background")}{background-image:linear-gradient(145deg,rgba(0,0,0,.78),rgba(0,0,0,.62)),url("${image}")!important;background-size:cover!important;background-position:center!important;}`;
    css += `${elementSelector("home.title")}{color:#fff!important;}${elementSelector("home.subtitle")}{color:#f1f5f9!important;}`;
    css += `${elementSelector("home.background")} .core-client-brand{color:#fff!important;}`;
  }
  for (const id of CORE_DESIGN_ELEMENT_IDS) {
    const override = Object.prototype.hasOwnProperty.call(design.elementOverrides, id) ? design.elementOverrides[id] : undefined;
    if (override) css += elementOverrideCss(id, override);
  }
  return css;
}

const Context = createContext<CoreDesign | null>(null);
export const useCoreClientDesign = () => useContext(Context);

export default function CoreClientDesign({ design, children }: { design: CoreDesign | null; children: React.ReactNode }) {
  if (!design) return <Context.Provider value={null}>{children}</Context.Provider>;
  const t = design.theme, f = design.typography;
  // These values are checked by the release contract; user text is rendered by React, never as HTML.
  const css = `
    html:root[data-core-design] {
      --app-background:${t.background};--app-surface:${t.surface};--app-surface-soft:${t.surface};--app-surface-strong:${t.surface};
      --app-border:${t.border};--app-border-strong:${t.border};--app-text:${t.text};--app-text-muted:${t.muted};--app-text-soft:${t.muted};
      --app-accent:${t.primary};--app-accent-dark:${t.primary};--app-accent-soft:${t.surface};--app-blue:${t.accent};--app-danger:${t.danger};--app-success:${t.success};
      --vates-canvas:${t.background};--vates-surface:${t.surface};--vates-border:${t.border};--vates-ink:${t.text};--vates-muted:${t.muted};--vates-accent:${t.primary};--vates-accent-soft:${t.surface};
    }
    html[data-core-design] body {background:${t.background}!important;color:${t.text}!important;font-family:${f.bodyFont}!important;font-size:${f.baseFontSizePx}px!important;}
    html[data-core-design] main,html[data-core-design] section,html[data-core-design] input,html[data-core-design] textarea,html[data-core-design] select,html[data-core-design] .login-page,html[data-core-design] .vates-footer {font-family:${f.bodyFont}!important;}
    html:root[data-core-design] h1,html:root[data-core-design] h2,html:root[data-core-design] h3,html:root[data-core-design] .core-client-brand {font-family:${f.headingFont}!important;}
    html:root[data-core-design] .vates-app-page h1,html:root[data-core-design] h1 {font-size:calc(2rem * ${f.headingScale})!important;}
    html:root[data-core-design] .vates-app-page h2,html:root[data-core-design] h2 {font-size:calc(1.5rem * ${f.headingScale})!important;}
    html[data-core-design] p,html[data-core-design] input,html[data-core-design] textarea {font-size:${f.baseFontSizePx}px!important;}
    html:root[data-core-design] body button,html:root[data-core-design] .login-page .login-box > button,html:root[data-core-design] .vates-app-page button {font-family:${f.buttonFont}!important;font-size:${f.buttonFontSizePx}px!important;border-radius:${f.buttonRadiusPx}px!important;}
    html[data-core-design] .vates-side-nav a,html[data-core-design] .vates-sidebar a {font-size:${f.navFontSizePx}px!important;}
    html[data-core-design] .login-box {background:${t.surface}!important;border-color:${t.border}!important;color:${t.text}!important;}
    html[data-core-design] .login-input {background:${t.background}!important;border-color:${t.border}!important;color:${t.text}!important;}
    html[data-core-design] .login-input::placeholder {color:${t.muted}!important;}
    html:root[data-core-design] .vates-auth-story {background:linear-gradient(145deg,color-mix(in srgb,${t.primary} 12%,${t.surface}),${t.background})!important;color:${t.text}!important;}
    html[data-core-design] .hover-unified-auth,html[data-core-design] .vates-button.primary {background:${t.button}!important;color:${t.buttonText}!important;}
    html[data-core-design] .vates-auth-message h1,html[data-core-design] .login-card-heading h1 {color:${t.text}!important;}
    html[data-core-design] .vates-auth-message p,html[data-core-design] .login-card-heading p {color:${t.muted}!important;}
    .core-client-brand {display:inline-flex;align-items:center;max-width:100%;color:var(--app-text);font-weight:800;overflow:hidden;text-overflow:ellipsis;}
    ${coreDesignV2Css(design)}
  `;
  return <Context.Provider value={design}><style data-core-design-style>{css}</style>{children}</Context.Provider>;
}
