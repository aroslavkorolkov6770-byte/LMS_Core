"use client";

import {
  ClientPreviewSettings,
  DEFAULT_CLIENT_PREVIEW_SETTINGS,
  mergeClientPreviewSettings,
  resolveLocalPreviewOrigin
} from "@lms-core/shared";

import { getIndustryTemplateShortLabel } from "./industry-options";

export type PreviewThemePalette = {
  primary: string;
  accent: string;
  background: string;
  surface: string;
  button: string;
};

export type PreviewFeatureFlags = {
  aiAssistant: boolean;
  advancedAnalytics: boolean;
  documentTemplates: boolean;
  excelExport: boolean;
  apiExport: boolean;
  multiBranch: boolean;
  branding: boolean;
};

export type PreviewRuntimeConfig = {
  enabled: boolean;
  editable: boolean;
  clientId: string | null;
  brandName: string | null;
  tariff: string;
  industryTemplate: string;
  industryLabel: string;
  palette: PreviewThemePalette;
  design: ClientPreviewSettings;
  features: PreviewFeatureFlags;
};

const DEFAULT_PALETTE: PreviewThemePalette = {
  primary: DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.primary,
  accent: DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.accent,
  background: DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.background,
  surface: DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.surface,
  button: DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.button
};

function readNumberParam(
  searchParams:
    | URLSearchParams
    | {
        get(name: string): string | null;
      },
  key: string,
  fallback: number
): number {
  const value = searchParams.get(key);

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBooleanParam(
  searchParams:
    | URLSearchParams
    | {
        get(name: string): string | null;
      },
  key: string,
  fallback: boolean
): boolean {
  const value = searchParams.get(key);

  if (!value) {
    return fallback;
  }

  return value === "1" || value === "true";
}

function readJsonParam(
  searchParams:
    | URLSearchParams
    | {
        get(name: string): string | null;
      },
  key: string
): unknown {
  const value = searchParams.get(key);

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function getPreviewFeatureFlags(tariff: string): PreviewFeatureFlags {
  if (tariff === "corporate") {
    return {
      aiAssistant: true,
      advancedAnalytics: true,
      documentTemplates: true,
      excelExport: true,
      apiExport: true,
      multiBranch: true,
      branding: true
    };
  }

  if (tariff === "extended") {
    return {
      aiAssistant: true,
      advancedAnalytics: true,
      documentTemplates: true,
      excelExport: true,
      apiExport: false,
      multiBranch: false,
      branding: true
    };
  }

  return {
    aiAssistant: false,
    advancedAnalytics: false,
    documentTemplates: true,
    excelExport: false,
    apiExport: false,
    multiBranch: false,
    branding: false
  };
}

export function getPreviewTariffLabel(tariff: string): string {
  if (tariff === "corporate") {
    return "Корпоративный";
  }

  if (tariff === "extended") {
    return "Расширенный";
  }

  return "Базовый";
}

export function readPreviewRuntime(
  searchParams:
    | URLSearchParams
    | {
        get(name: string): string | null;
      }
): PreviewRuntimeConfig {
  const clientId = searchParams.get("previewClientId");
  const enabled = Boolean(clientId);
  const editable = searchParams.get("previewEditable") === "1";
  const tariff = searchParams.get("previewTariff") ?? "base";
  const industryTemplate = searchParams.get("previewIndustryTemplate") ?? "coffee_shop";
  const design = mergeClientPreviewSettings({
    version: 1,
    theme: {
      primary: searchParams.get("previewPrimary") ?? DEFAULT_PALETTE.primary,
      accent: searchParams.get("previewAccent") ?? DEFAULT_PALETTE.accent,
      background: searchParams.get("previewBackground") ?? DEFAULT_PALETTE.background,
      surface: searchParams.get("previewSurface") ?? DEFAULT_PALETTE.surface,
      button: searchParams.get("previewButton") ?? searchParams.get("previewPrimary") ?? DEFAULT_PALETTE.button,
      buttonText:
        searchParams.get("previewButtonText") ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.buttonText,
      text: searchParams.get("previewText") ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.text,
      muted: searchParams.get("previewMuted") ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.muted,
      border: searchParams.get("previewBorder") ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.border,
      success: searchParams.get("previewSuccess") ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.success,
      danger: searchParams.get("previewDanger") ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.danger
    },
    typography: {
      headingFont:
        searchParams.get("previewHeadingFont") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.typography.headingFont,
      bodyFont:
        searchParams.get("previewBodyFont") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.typography.bodyFont,
      buttonFont:
        searchParams.get("previewButtonFont") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.typography.buttonFont,
      baseFontSizePx: readNumberParam(
        searchParams,
        "previewBaseFontSizePx",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.typography.baseFontSizePx
      ),
      headingScale: readNumberParam(
        searchParams,
        "previewHeadingScale",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.typography.headingScale
      ),
      buttonFontSizePx: readNumberParam(
        searchParams,
        "previewButtonFontSizePx",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.typography.buttonFontSizePx
      ),
      buttonRadiusPx: readNumberParam(
        searchParams,
        "previewButtonRadiusPx",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.typography.buttonRadiusPx
      ),
      navFontSizePx: readNumberParam(
        searchParams,
        "previewNavFontSizePx",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.typography.navFontSizePx
      )
    },
    content: {
      homeBadge:
        searchParams.get("previewHomeBadge") ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.content.homeBadge,
      homeBackgroundImageUrl:
        searchParams.get("previewHomeBackgroundImageUrl") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.homeBackgroundImageUrl,
      homeTitle:
        searchParams.get("previewHomeTitle") ??
        searchParams.get("previewBrandName") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.homeTitle,
      homeSubtitle:
        searchParams.get("previewHomeSubtitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.homeSubtitle,
      homeFeatureCards:
        readJsonParam(searchParams, "previewHomeFeatureCards") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.homeFeatureCards,
      primaryCtaLabel:
        searchParams.get("previewPrimaryCtaLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.primaryCtaLabel,
      loginTitle:
        searchParams.get("previewLoginTitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.loginTitle,
      loginSubtitle:
        searchParams.get("previewLoginSubtitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.loginSubtitle,
      loginButtonLabel:
        searchParams.get("previewLoginButtonLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.loginButtonLabel,
      registerButtonLabel:
        searchParams.get("previewRegisterButtonLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.registerButtonLabel,
      cancelLabel:
        searchParams.get("previewCancelLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.cancelLabel,
      tasksDashboardTitle:
        searchParams.get("previewTasksDashboardTitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.tasksDashboardTitle,
      tasksDashboardCaption:
        searchParams.get("previewTasksDashboardCaption") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.tasksDashboardCaption,
      learningRoleTrackLabel:
        searchParams.get("previewLearningRoleTrackLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningRoleTrackLabel,
      learningRoleTrackItems:
        readJsonParam(searchParams, "previewLearningRoleTrackItems") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningRoleTrackItems,
      learningUrgentTitle:
        searchParams.get("previewLearningUrgentTitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningUrgentTitle,
      learningUrgentEmptyText:
        searchParams.get("previewLearningUrgentEmptyText") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningUrgentEmptyText,
      learningTheoryTitle:
        searchParams.get("previewLearningTheoryTitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningTheoryTitle,
      learningTestsTitle:
        searchParams.get("previewLearningTestsTitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningTestsTitle,
      learningDefaultSectionLabel:
        searchParams.get("previewLearningDefaultSectionLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningDefaultSectionLabel,
      learningEmptyTheoryText:
        searchParams.get("previewLearningEmptyTheoryText") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningEmptyTheoryText,
      learningEmptyTestsText:
        searchParams.get("previewLearningEmptyTestsText") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.learningEmptyTestsText,
      adminTitle:
        searchParams.get("previewAdminTitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.adminTitle,
      adminSubtitle:
        searchParams.get("previewAdminSubtitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.adminSubtitle,
      profileTitle:
        searchParams.get("previewProfileTitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.profileTitle,
      profileSubtitle:
        searchParams.get("previewProfileSubtitle") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.profileSubtitle,
      navHomeLabel:
        searchParams.get("previewNavHomeLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.navHomeLabel,
      navTasksLabel:
        searchParams.get("previewNavTasksLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.navTasksLabel,
      navAdminLabel:
        searchParams.get("previewNavAdminLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.navAdminLabel,
      navProfileLabel:
        searchParams.get("previewNavProfileLabel") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.content.navProfileLabel
    },
    layout: {
      density:
        searchParams.get("previewDensity") === "compact" ||
        searchParams.get("previewDensity") === "spacious"
          ? (searchParams.get("previewDensity") as "compact" | "spacious")
          : DEFAULT_CLIENT_PREVIEW_SETTINGS.layout.density,
      cardRadiusPx: readNumberParam(
        searchParams,
        "previewCardRadiusPx",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.layout.cardRadiusPx
      ),
      sectionGapPx: readNumberParam(
        searchParams,
        "previewSectionGapPx",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.layout.sectionGapPx
      ),
      homeCtaOffsetX: readNumberParam(
        searchParams,
        "previewHomeCtaOffsetX",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.layout.homeCtaOffsetX
      ),
      homeCtaOffsetY: readNumberParam(
        searchParams,
        "previewHomeCtaOffsetY",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.layout.homeCtaOffsetY
      ),
      homeCtaAlign:
        searchParams.get("previewHomeCtaAlign") === "left" ||
        searchParams.get("previewHomeCtaAlign") === "right"
          ? (searchParams.get("previewHomeCtaAlign") as "left" | "right")
          : DEFAULT_CLIENT_PREVIEW_SETTINGS.layout.homeCtaAlign,
      homeSectionOrder:
        readJsonParam(searchParams, "previewHomeSectionOrder") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.layout.homeSectionOrder,
      homeFeatureCardOrder:
        readJsonParam(searchParams, "previewHomeFeatureCardOrder") ??
        DEFAULT_CLIENT_PREVIEW_SETTINGS.layout.homeFeatureCardOrder
    },
    components: {
      showHomeCta: readBooleanParam(
        searchParams,
        "previewShowHomeCta",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.components.showHomeCta
      ),
      smoothTabs: readBooleanParam(
        searchParams,
        "previewSmoothTabs",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.components.smoothTabs
      ),
      buttonShadow: readBooleanParam(
        searchParams,
        "previewButtonShadow",
        DEFAULT_CLIENT_PREVIEW_SETTINGS.components.buttonShadow
      )
    },
    elementOverrides: readJsonParam(searchParams, "previewElementOverrides")
  });

  return {
    enabled,
    editable,
    clientId,
    brandName: searchParams.get("previewBrandName"),
    tariff,
    industryTemplate,
    industryLabel: getIndustryTemplateShortLabel(industryTemplate),
    palette: {
      primary: design.theme.primary,
      accent: design.theme.accent,
      background: design.theme.background,
      surface: design.theme.surface,
      button: design.theme.button
    },
    design,
    features: getPreviewFeatureFlags(tariff)
  };
}

export function isPreviewLocation(search: string): boolean {
  return search.includes("previewClientId=");
}

export function appendPreviewParams(
  path: string,
  searchParams:
    | URLSearchParams
    | {
        get(name: string): string | null;
      }
): string {
  const previewClientId = searchParams.get("previewClientId");

  if (!previewClientId) {
    return path;
  }

  const url = new URL(path, resolveLocalPreviewOrigin(process.env.NEXT_PUBLIC_LMS_PREVIEW_ORIGIN));

  [
    "previewClientId",
    "previewBrandName",
    "previewTariff",
    "previewIndustryTemplate",
    "previewPrimary",
    "previewAccent",
    "previewBackground",
    "previewSurface",
    "previewButton",
    "previewButtonText",
    "previewText",
    "previewMuted",
    "previewBorder",
    "previewSuccess",
    "previewDanger",
    "previewHeadingFont",
    "previewBodyFont",
    "previewButtonFont",
    "previewBaseFontSizePx",
    "previewHeadingScale",
    "previewButtonFontSizePx",
    "previewButtonRadiusPx",
    "previewNavFontSizePx",
    "previewHomeBadge",
    "previewHomeBackgroundImageUrl",
    "previewHomeTitle",
    "previewHomeSubtitle",
    "previewHomeFeatureCards",
    "previewPrimaryCtaLabel",
    "previewLoginTitle",
    "previewLoginSubtitle",
    "previewLoginButtonLabel",
    "previewRegisterButtonLabel",
    "previewCancelLabel",
    "previewTasksDashboardTitle",
    "previewTasksDashboardCaption",
    "previewLearningRoleTrackLabel",
    "previewLearningRoleTrackItems",
    "previewLearningUrgentTitle",
    "previewLearningUrgentEmptyText",
    "previewLearningTheoryTitle",
    "previewLearningTestsTitle",
    "previewLearningDefaultSectionLabel",
    "previewLearningEmptyTheoryText",
    "previewLearningEmptyTestsText",
    "previewAdminTitle",
    "previewAdminSubtitle",
    "previewProfileTitle",
    "previewProfileSubtitle",
    "previewNavHomeLabel",
    "previewNavTasksLabel",
    "previewNavAdminLabel",
    "previewNavProfileLabel",
    "previewDensity",
    "previewCardRadiusPx",
    "previewSectionGapPx",
    "previewHomeCtaOffsetX",
    "previewHomeCtaOffsetY",
    "previewHomeCtaAlign",
    "previewHomeSectionOrder",
    "previewHomeFeatureCardOrder",
    "previewShowHomeCta",
    "previewSmoothTabs",
    "previewButtonShadow",
    "previewElementOverrides",
    "previewEditable",
    "previewReadonly"
  ].forEach((key) => {
    const value = searchParams.get(key);

    if (value) {
      url.searchParams.set(key, value);
    }
  });

  return `${url.pathname}${url.search}${url.hash}`;
}
