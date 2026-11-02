export type ClientPreviewTheme = {
  primary: string;
  accent: string;
  background: string;
  surface: string;
  button: string;
  buttonText: string;
  text: string;
  muted: string;
  border: string;
  success: string;
  danger: string;
};

export type ClientPreviewTypography = {
  headingFont: string;
  bodyFont: string;
  buttonFont: string;
  baseFontSizePx: number;
  headingScale: number;
  buttonFontSizePx: number;
  buttonRadiusPx: number;
  navFontSizePx: number;
};

export type ClientPreviewContent = {
  homeBadge: string;
  homeBackgroundImageUrl: string;
  homeTitle: string;
  homeSubtitle: string;
  homeFeatureCards: ClientPreviewFeatureCardContent[];
  primaryCtaLabel: string;
  loginTitle: string;
  loginSubtitle: string;
  loginButtonLabel: string;
  registerButtonLabel: string;
  cancelLabel: string;
  tasksDashboardTitle: string;
  tasksDashboardCaption: string;
  learningRoleTrackLabel: string;
  learningRoleTrackItems: string[];
  learningUrgentTitle: string;
  learningUrgentEmptyText: string;
  learningTheoryTitle: string;
  learningTestsTitle: string;
  learningDefaultSectionLabel: string;
  learningEmptyTheoryText: string;
  learningEmptyTestsText: string;
  adminTitle: string;
  adminSubtitle: string;
  profileTitle: string;
  profileSubtitle: string;
  navHomeLabel: string;
  navTasksLabel: string;
  navAdminLabel: string;
  navProfileLabel: string;
};

export type ClientPreviewFeatureCardContent = {
  title: string;
  desc: string;
};

export type ClientPreviewHomeSection = "hero" | "features";

export type ClientPreviewLayout = {
  density: "compact" | "normal" | "spacious";
  cardRadiusPx: number;
  sectionGapPx: number;
  homeCtaOffsetX: number;
  homeCtaOffsetY: number;
  homeCtaAlign: "left" | "center" | "right";
  homeSectionOrder: ClientPreviewHomeSection[];
  homeFeatureCardOrder: number[];
};

export type ClientPreviewComponents = {
  showHomeCta: boolean;
  smoothTabs: boolean;
  buttonShadow: boolean;
};

export type ClientPreviewElementAlign = "left" | "center" | "right";

export type ClientPreviewElementOverride = {
  visible: boolean;
  widthPercent: number;
  marginTopPx: number;
  marginBottomPx: number;
  paddingPx: number;
  offsetX: number;
  offsetY: number;
  align: ClientPreviewElementAlign;
  backgroundColor: string;
  textColor: string;
  borderColor: string;
};

export type ClientPreviewElementOverrides = Record<string, ClientPreviewElementOverride>;

export type ClientPreviewSettings = {
  version: 1;
  theme: ClientPreviewTheme;
  typography: ClientPreviewTypography;
  content: ClientPreviewContent;
  layout: ClientPreviewLayout;
  components: ClientPreviewComponents;
  elementOverrides: ClientPreviewElementOverrides;
};

export const DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE: ClientPreviewElementOverride = {
  visible: true,
  widthPercent: 100,
  marginTopPx: 0,
  marginBottomPx: 0,
  paddingPx: 0,
  offsetX: 0,
  offsetY: 0,
  align: "center",
  backgroundColor: "",
  textColor: "",
  borderColor: ""
};

export const DEFAULT_CLIENT_PREVIEW_HOME_SECTION_ORDER: ClientPreviewHomeSection[] = [
  "hero",
  "features"
];

export const DEFAULT_CLIENT_PREVIEW_HOME_FEATURE_CARD_ORDER = [0, 1, 2];

export const DEFAULT_CLIENT_PREVIEW_HOME_FEATURE_CARDS: ClientPreviewFeatureCardContent[] = [];

export const DEFAULT_CLIENT_PREVIEW_SETTINGS: ClientPreviewSettings = {
  version: 1,
  theme: {
    primary: "#0abab5",
    accent: "#6ee7d8",
    background: "#071419",
    surface: "#0f2229",
    button: "#0abab5",
    buttonText: "#081015",
    text: "#ffffff",
    muted: "#a7b1b7",
    border: "rgba(255,255,255,0.12)",
    success: "#34d399",
    danger: "#fb7185"
  },
  typography: {
    headingFont: "Inter",
    bodyFont: "Inter",
    buttonFont: "Inter",
    baseFontSizePx: 16,
    headingScale: 1,
    buttonFontSizePx: 16,
    buttonRadiusPx: 999,
    navFontSizePx: 14
  },
  content: {
    homeBadge: "Мастер Платформа",
    homeBackgroundImageUrl: "https://u.9111s.ru/uploads/202402/17/a0254a12ef37da5aaf5c5646a30baab8.webp",
    homeTitle: "TEA HUB",
    homeSubtitle: "Среда для обучения и развития. Ваш путь от новичка до эксперта.",
    homeFeatureCards: [...DEFAULT_CLIENT_PREVIEW_HOME_FEATURE_CARDS],
    primaryCtaLabel: "Начать обучение",
    loginTitle: "Вход в систему",
    loginSubtitle: "Вход в платформу",
    loginButtonLabel: "Войти",
    registerButtonLabel: "Регистрация",
    cancelLabel: "Отмена",
    tasksDashboardTitle: "Центр обучения",
    tasksDashboardCaption: "Здесь сотрудник видит учебный путь, прогресс и материалы по своей роли.",
    learningRoleTrackLabel: "",
    learningRoleTrackItems: [],
    learningUrgentTitle: "Срочно к прохождению",
    learningUrgentEmptyText: "У вас нет срочных заданий.",
    learningTheoryTitle: "Теория",
    learningTestsTitle: "Тесты",
    learningDefaultSectionLabel: "Основной раздел",
    learningEmptyTheoryText: "Пока нет учебных тем.",
    learningEmptyTestsText: "Пока нет тестов.",
    adminTitle: "Админ-панель клиента",
    adminSubtitle: "Управление сотрудниками, материалами, тестами и результатами.",
    profileTitle: "Профиль сотрудника",
    profileSubtitle: "Личные данные, уведомления и настройки аккаунта.",
    navHomeLabel: "Главная",
    navTasksLabel: "Обучение",
    navAdminLabel: "Админ",
    navProfileLabel: "Профиль"
  },
  layout: {
    density: "normal",
    cardRadiusPx: 40,
    sectionGapPx: 30,
    homeCtaOffsetX: 0,
    homeCtaOffsetY: 0,
    homeCtaAlign: "center",
    homeSectionOrder: [...DEFAULT_CLIENT_PREVIEW_HOME_SECTION_ORDER],
    homeFeatureCardOrder: [...DEFAULT_CLIENT_PREVIEW_HOME_FEATURE_CARD_ORDER]
  },
  components: {
    showHomeCta: false,
    smoothTabs: true,
    buttonShadow: true
  },
  elementOverrides: {}
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeObject<T extends Record<string, unknown>>(base: T, patch: unknown): T {
  if (!isObject(patch)) {
    return base;
  }

  return {
    ...base,
    ...patch
  };
}

function mergeElementOverride(input: unknown): ClientPreviewElementOverride {
  const merged = mergeObject(DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE, input);

  return {
    visible: typeof merged.visible === "boolean" ? merged.visible : true,
    widthPercent:
      typeof merged.widthPercent === "number" && Number.isFinite(merged.widthPercent)
        ? merged.widthPercent
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.widthPercent,
    marginTopPx:
      typeof merged.marginTopPx === "number" && Number.isFinite(merged.marginTopPx)
        ? merged.marginTopPx
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.marginTopPx,
    marginBottomPx:
      typeof merged.marginBottomPx === "number" && Number.isFinite(merged.marginBottomPx)
        ? merged.marginBottomPx
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.marginBottomPx,
    paddingPx:
      typeof merged.paddingPx === "number" && Number.isFinite(merged.paddingPx)
        ? merged.paddingPx
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.paddingPx,
    offsetX:
      typeof merged.offsetX === "number" && Number.isFinite(merged.offsetX)
        ? merged.offsetX
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.offsetX,
    offsetY:
      typeof merged.offsetY === "number" && Number.isFinite(merged.offsetY)
        ? merged.offsetY
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.offsetY,
    align:
      merged.align === "left" || merged.align === "right" || merged.align === "center"
        ? merged.align
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.align,
    backgroundColor:
      typeof merged.backgroundColor === "string"
        ? merged.backgroundColor
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.backgroundColor,
    textColor:
      typeof merged.textColor === "string"
        ? merged.textColor
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.textColor,
    borderColor:
      typeof merged.borderColor === "string"
        ? merged.borderColor
        : DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE.borderColor
  };
}

function mergeElementOverrides(input: unknown): ClientPreviewElementOverrides {
  if (!isObject(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input)
      .filter(([elementId]) => elementId.length > 0)
      .map(([elementId, value]) => [elementId, mergeElementOverride(value)])
  );
}

function normalizeHomeSectionOrder(input: unknown): ClientPreviewHomeSection[] {
  const allowedSections = DEFAULT_CLIENT_PREVIEW_HOME_SECTION_ORDER;
  const rawSections = Array.isArray(input) ? input : allowedSections;
  const normalizedSections = rawSections.filter((section): section is ClientPreviewHomeSection =>
    allowedSections.includes(section as ClientPreviewHomeSection)
  );

  allowedSections.forEach((section) => {
    if (!normalizedSections.includes(section)) {
      normalizedSections.push(section);
    }
  });

  return normalizedSections;
}

function normalizeHomeFeatureCardOrder(input: unknown): number[] {
  const rawIndexes = Array.isArray(input) ? input : DEFAULT_CLIENT_PREVIEW_HOME_FEATURE_CARD_ORDER;
  const normalizedIndexes: number[] = [];

  rawIndexes.forEach((index) => {
    if (
      typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0 &&
      index <= 24 &&
      !normalizedIndexes.includes(index)
    ) {
      normalizedIndexes.push(index);
    }
  });

  DEFAULT_CLIENT_PREVIEW_HOME_FEATURE_CARD_ORDER.forEach((index) => {
    if (!normalizedIndexes.includes(index)) {
      normalizedIndexes.push(index);
    }
  });

  return normalizedIndexes;
}

function normalizeFeatureCardContent(input: unknown): ClientPreviewFeatureCardContent[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.slice(0, 24).map((card) => {
    if (!isObject(card)) {
      return { title: "", desc: "" };
    }

    return {
      title: typeof card.title === "string" ? card.title.trim() : "",
      desc: typeof card.desc === "string" ? card.desc.trim() : ""
    };
  });
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .slice(0, 24)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

export function mergeClientPreviewSettings(input: unknown): ClientPreviewSettings {
  if (!isObject(input)) {
    return DEFAULT_CLIENT_PREVIEW_SETTINGS;
  }

  const mergedLayout = mergeObject(DEFAULT_CLIENT_PREVIEW_SETTINGS.layout, input.layout);
  const mergedContent = mergeObject(DEFAULT_CLIENT_PREVIEW_SETTINGS.content, input.content);

  return {
    version: 1,
    theme: mergeObject(DEFAULT_CLIENT_PREVIEW_SETTINGS.theme, input.theme),
    typography: mergeObject(DEFAULT_CLIENT_PREVIEW_SETTINGS.typography, input.typography),
    content: {
      ...mergedContent,
      homeFeatureCards: normalizeFeatureCardContent(mergedContent.homeFeatureCards),
      learningRoleTrackItems: normalizeStringList(mergedContent.learningRoleTrackItems)
    },
    layout: {
      ...mergedLayout,
      homeSectionOrder: normalizeHomeSectionOrder(mergedLayout.homeSectionOrder),
      homeFeatureCardOrder: normalizeHomeFeatureCardOrder(mergedLayout.homeFeatureCardOrder)
    },
    components: mergeObject(DEFAULT_CLIENT_PREVIEW_SETTINGS.components, input.components),
    elementOverrides: mergeElementOverrides(input.elementOverrides)
  };
}

export function getClientPreviewElementOverride(
  settings: ClientPreviewSettings,
  elementId: string | null | undefined
): ClientPreviewElementOverride {
  if (!elementId) {
    return DEFAULT_CLIENT_PREVIEW_ELEMENT_OVERRIDE;
  }

  return mergeElementOverride(settings.elementOverrides[elementId]);
}
