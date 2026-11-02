"use client";

import {
  DEFAULT_CLIENT_PREVIEW_SETTINGS,
  getClientPreviewElementOverride,
  mergeClientPreviewSettings,
  resolveLocalPreviewOrigin,
  type ClientPreviewElementAlign,
  type ClientPreviewElementOverride,
  type ClientPreviewContent,
  type ClientPreviewFeatureCardContent,
  type ClientPreviewHomeSection,
  type ClientPreviewSettings
} from "@lms-core/shared";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { getIndustryContent } from "../lib/industry-content";
import { getIndustryTemplateShortLabel, INDUSTRY_TEMPLATE_OPTIONS } from "../lib/industry-options";
import { PREVIEW_EDITOR_SOURCE, type PreviewDraft } from "../lib/preview-draft-store";
import { PreviewRequestError, previewSaveFailureMessage, requestPreviewJson } from "../lib/preview-request";
import type { PreviewControlState } from "../lib/preview-controls";
import { connectCoreEditorState, type CoreEditorState } from "../lib/core-editor-state";

const LOCAL_PREVIEW_ORIGIN = resolveLocalPreviewOrigin(process.env.NEXT_PUBLIC_LMS_PREVIEW_ORIGIN);

type TariffFeatures = {
  code: string;
  label: string;
  maxAdmins: number;
  includedUsers: number;
  aiAssistant: boolean;
  advancedAnalytics: boolean;
  documentTemplates: boolean;
  excelExport: boolean;
  apiExport: boolean;
  multiBranch: boolean;
  branding: boolean;
  slaHours: number | null;
};

type DeployClientCard = {
  id: string;
  name: string;
  domain: string;
  brandName: string;
  tariff: string;
  industryTemplate: string;
  deployStatusLabel: string;
  features: TariffFeatures;
};

type DeployProfile = {
  hostUrl: string;
  deployPath: string | null;
  lmsSourcePath: string | null;
  deploymentBundlePath: string | null;
  aiProvider: string;
  aiModel: string;
  aliceTenantCode: string | null;
  aliceModelPreset: string | null;
  previewThemePrimary: string | null;
  previewThemeAccent: string | null;
  previewThemeBackground: string | null;
  previewThemeSurface: string | null;
};

type DeployClientDetail = {
  client: DeployClientCard;
  profile: DeployProfile | null;
};

type PreviewOverrides = {
  brandName?: string;
  tariff?: string;
  industryTemplate?: string;
  primary?: string;
  accent?: string;
  background?: string;
  surface?: string;
  button?: string;
};

type PreviewScreen = {
  key: string;
  label: string;
  href: string;
  enabled: boolean;
};

type InspectorTab = "content" | "learning" | "colors" | "typography" | "element" | "layout" | "launch";

type PreviewRuntimeMessage = {
  source?: string;
  type?: string;
  elementId?: string;
  offsetX?: number;
  offsetY?: number;
  nextText?: string;
  clientId?: string;
  revision?: number;
};

type LegacyRouteItem = {
  id: string;
  title: string;
  time?: string;
  section?: string;
  h1?: string;
  t1?: string;
  h2?: string;
  t2?: string;
  h3?: string;
  t3?: string;
  isPlaceholder?: boolean;
  [key: string]: unknown;
};

type LegacyQuizQuestion = {
  q: string;
  o: string[];
  c: number;
};

type LegacyTestItem = {
  id: string;
  title: string;
  subtitle?: string;
  theory?: string;
  section?: string;
  timeLimit?: number;
  quiz?: LegacyQuizQuestion[];
  isPlaceholder?: boolean;
  [key: string]: unknown;
};

type LearningContentStatus = "idle" | "loading" | "dirty" | "saving" | "saved" | "error";

const PREVIEW_RUNTIME_SOURCE = "lms-preview-runtime";

const FONT_OPTIONS = ["Inter", "Arial", "Georgia", "Verdana", "Trebuchet MS", "Tahoma", "Times New Roman"];

type PreviewContentField = Exclude<
  keyof ClientPreviewContent,
  "homeFeatureCards" | "learningRoleTrackItems"
>;

const HOME_SECTION_LABELS: Record<ClientPreviewHomeSection, string> = {
  hero: "Главный экран",
  features: "Карточки преимуществ"
};

type EditableElementMeta = {
  id: string;
  label: string;
  tab: InspectorTab;
  note: string;
};

const EDITABLE_ELEMENT_REGISTRY: Record<string, EditableElementMeta> = {
  "home.background": {
    id: "home.background",
    label: "Фоновое изображение главной",
    tab: "element",
    note: "Загрузи PNG, JPEG или WebP до 4 МБ. После сохранения файл войдет в устанавливаемую LMS."
  },
  "home.badge": {
    id: "home.badge",
    label: "Бейдж главной",
    tab: "content",
    note: "Короткая подпись над главным заголовком."
  },
  "home.title": {
    id: "home.title",
    label: "Главный заголовок",
    tab: "content",
    note: "Основной брендовый заголовок первой страницы."
  },
  "home.subtitle": {
    id: "home.subtitle",
    label: "Подзаголовок",
    tab: "content",
    note: "Текст под главным заголовком."
  },
  "home.cta": {
    id: "home.cta",
    label: "CTA-кнопка",
    tab: "layout",
    note: "Главная кнопка. Ее можно включать, двигать, менять текст, радиус и цвет."
  },
  "home.features": {
    id: "home.features",
    label: "Карточки преимуществ",
    tab: "layout",
    note: "Блок карточек на главной. Сейчас управляются отступы и скругление."
  },
  "tasks.dashboardTitle": {
    id: "tasks.dashboardTitle",
    label: "Заголовок кабинета",
    tab: "content",
    note: "Главный заголовок учебного кабинета клиента."
  },
  "tasks.dashboardCaption": {
    id: "tasks.dashboardCaption",
    label: "Описание кабинета",
    tab: "content",
    note: "Пояснение под заголовком кабинета."
  },
  "tasks.roleTrackLabel": {
    id: "tasks.roleTrackLabel",
    label: "Заголовок стартовых ролей",
    tab: "content",
    note: "Название блока ролей на первом экране учебного кабинета."
  },
  "tasks.learningUrgentTitle": {
    id: "tasks.learningUrgentTitle",
    label: "Заголовок срочных заданий",
    tab: "content",
    note: "Название блока срочных заданий на экране обучения."
  },
  "tasks.learningUrgentEmptyText": {
    id: "tasks.learningUrgentEmptyText",
    label: "Пусто: срочные задания",
    tab: "content",
    note: "Текст, когда у сотрудника нет срочных заданий."
  },
  "tasks.learningTheoryTitle": {
    id: "tasks.learningTheoryTitle",
    label: "Заголовок теории",
    tab: "content",
    note: "Название блока учебных тем."
  },
  "tasks.learningTestsTitle": {
    id: "tasks.learningTestsTitle",
    label: "Заголовок тестов",
    tab: "content",
    note: "Название блока тестов."
  },
  "tasks.learningEmptyTheoryText": {
    id: "tasks.learningEmptyTheoryText",
    label: "Пусто: теория",
    tab: "content",
    note: "Текст, когда в учебном пути нет тем."
  },
  "tasks.learningEmptyTestsText": {
    id: "tasks.learningEmptyTestsText",
    label: "Пусто: тесты",
    tab: "content",
    note: "Текст, когда в учебном пути нет тестов."
  },
  "login.card": {
    id: "login.card",
    label: "Карточка входа",
    tab: "layout",
    note: "Контейнер формы входа и регистрации."
  },
  "login.title": {
    id: "login.title",
    label: "Заголовок входа",
    tab: "content",
    note: "Верхний заголовок формы авторизации."
  },
  "login.subtitle": {
    id: "login.subtitle",
    label: "Подзаголовок входа",
    tab: "content",
    note: "Короткая подпись под заголовком формы."
  },
  "login.primaryAction": {
    id: "login.primaryAction",
    label: "Главная кнопка входа",
    tab: "layout",
    note: "Кнопка входа или регистрации в текущем режиме формы."
  },
  "admin.shell": {
    id: "admin.shell",
    label: "Рабочая область админки",
    tab: "layout",
    note: "Основная область управления клиентской LMS."
  },
  "admin.title": {
    id: "admin.title",
    label: "Заголовок админки",
    tab: "content",
    note: "Верхний заголовок экрана администратора клиента."
  },
  "admin.subtitle": {
    id: "admin.subtitle",
    label: "Описание админки",
    tab: "content",
    note: "Пояснение под заголовком админского экрана."
  },
  "admin.testResults": {
    id: "admin.testResults",
    label: "Результаты тестов",
    tab: "content",
    note: "Блок просмотра попыток и результатов тестирования."
  },
  "profile.card": {
    id: "profile.card",
    label: "Карточка профиля",
    tab: "layout",
    note: "Главная карточка профиля сотрудника."
  },
  "profile.title": {
    id: "profile.title",
    label: "Заголовок профиля",
    tab: "content",
    note: "Верхний заголовок страницы профиля."
  },
  "profile.subtitle": {
    id: "profile.subtitle",
    label: "Описание профиля",
    tab: "content",
    note: "Короткое пояснение под заголовком профиля."
  },
  "profile.name": {
    id: "profile.name",
    label: "Имя профиля",
    tab: "content",
    note: "Отображаемое имя сотрудника в профиле."
  }
};

const TEXT_EDITABLE_ELEMENT_CONTENT_FIELDS: Partial<Record<string, PreviewContentField>> = {
  "home.badge": "homeBadge",
  "home.title": "homeTitle",
  "home.subtitle": "homeSubtitle",
  "home.cta": "primaryCtaLabel",
  "tasks.dashboardTitle": "tasksDashboardTitle",
  "tasks.learningUrgentTitle": "learningUrgentTitle",
  "tasks.learningUrgentEmptyText": "learningUrgentEmptyText",
  "tasks.learningTheoryTitle": "learningTheoryTitle",
  "tasks.learningTestsTitle": "learningTestsTitle",
  "tasks.learningEmptyTheoryText": "learningEmptyTheoryText",
  "tasks.learningEmptyTestsText": "learningEmptyTestsText",
  "login.title": "loginTitle",
  "login.subtitle": "loginSubtitle",
  "login.primaryAction": "loginButtonLabel"
};

const CONTENT_FIELD_LABELS: Record<PreviewContentField, string> = {
  homeBadge: "Бейдж на главной",
  homeBackgroundImageUrl: "Фоновое изображение главной",
  homeTitle: "Главный заголовок",
  homeSubtitle: "Подзаголовок",
  primaryCtaLabel: "Текст CTA-кнопки",
  loginTitle: "Заголовок формы входа",
  loginSubtitle: "Подзаголовок формы входа",
  loginButtonLabel: "Кнопка входа",
  registerButtonLabel: "Кнопка регистрации",
  cancelLabel: "Отмена",
  tasksDashboardTitle: "Заголовок кабинета",
  tasksDashboardCaption: "Описание кабинета",
  learningRoleTrackLabel: "Заголовок стартовых ролей",
  learningUrgentTitle: "Заголовок срочных заданий",
  learningUrgentEmptyText: "Пусто: срочные задания",
  learningTheoryTitle: "Заголовок теории",
  learningTestsTitle: "Заголовок тестов",
  learningDefaultSectionLabel: "Название основного раздела",
  learningEmptyTheoryText: "Пусто: теория",
  learningEmptyTestsText: "Пусто: тесты",
  adminTitle: "Заголовок админки",
  adminSubtitle: "Описание админки",
  profileTitle: "Заголовок профиля",
  profileSubtitle: "Описание профиля",
  navHomeLabel: "Навигация: главная",
  navTasksLabel: "Навигация: обучение",
  navAdminLabel: "Навигация: админ",
  navProfileLabel: "Навигация: профиль"
};

function getEditableElementMeta(id: string | null): EditableElementMeta | null {
  if (!id) {
    return null;
  }

  return EDITABLE_ELEMENT_REGISTRY[id] ?? null;
}

function getContentFieldForEditableElement(elementId: string | null): PreviewContentField | null {
  if (!elementId) {
    return null;
  }

  return TEXT_EDITABLE_ELEMENT_CONTENT_FIELDS[elementId] ?? null;
}

function getLiveSiteUrl(profile: DeployProfile | null): string | null {
  if (!profile?.hostUrl) {
    return null;
  }

  if (profile.deployPath && profile.deployPath.length > 1) {
    return `${profile.hostUrl}${profile.deployPath}`;
  }

  return profile.hostUrl;
}

function getTariffFlags(tariff: string): TariffFeatures {
  if (tariff === "corporate") {
    return {
      code: "corporate",
      label: "Корпоративный",
      maxAdmins: 10,
      includedUsers: 500,
      aiAssistant: true,
      advancedAnalytics: true,
      documentTemplates: true,
      excelExport: true,
      apiExport: true,
      multiBranch: true,
      branding: true,
      slaHours: 4
    };
  }

  if (tariff === "extended") {
    return {
      code: "extended",
      label: "Расширенный",
      maxAdmins: 3,
      includedUsers: 50,
      aiAssistant: true,
      advancedAnalytics: true,
      documentTemplates: true,
      excelExport: true,
      apiExport: false,
      multiBranch: false,
      branding: true,
      slaHours: 12
    };
  }

  return {
    code: "base",
    label: "Базовый",
    maxAdmins: 1,
    includedUsers: 5,
    aiAssistant: false,
    advancedAnalytics: false,
    documentTemplates: true,
    excelExport: false,
    apiExport: false,
    multiBranch: false,
    branding: false,
    slaHours: null
  };
}

function addSettingsParams(url: URL, settings: ClientPreviewSettings): void {
  const themeParams: Record<string, string> = {
    previewPrimary: settings.theme.primary,
    previewAccent: settings.theme.accent,
    previewBackground: settings.theme.background,
    previewSurface: settings.theme.surface,
    previewButton: settings.theme.button,
    previewButtonText: settings.theme.buttonText,
    previewText: settings.theme.text,
    previewMuted: settings.theme.muted,
    previewBorder: settings.theme.border,
    previewSuccess: settings.theme.success,
    previewDanger: settings.theme.danger
  };

  const typographyParams: Record<string, string> = {
    previewHeadingFont: settings.typography.headingFont,
    previewBodyFont: settings.typography.bodyFont,
    previewButtonFont: settings.typography.buttonFont,
    previewBaseFontSizePx: String(settings.typography.baseFontSizePx),
    previewHeadingScale: String(settings.typography.headingScale),
    previewButtonFontSizePx: String(settings.typography.buttonFontSizePx),
    previewButtonRadiusPx: String(settings.typography.buttonRadiusPx),
    previewNavFontSizePx: String(settings.typography.navFontSizePx)
  };

  const contentParams: Record<string, string> = {
    previewHomeBadge: settings.content.homeBadge,
    previewHomeBackgroundImageUrl: settings.content.homeBackgroundImageUrl,
    previewHomeTitle: settings.content.homeTitle,
    previewHomeSubtitle: settings.content.homeSubtitle,
    previewHomeFeatureCards: JSON.stringify(settings.content.homeFeatureCards),
    previewPrimaryCtaLabel: settings.content.primaryCtaLabel,
    previewLoginTitle: settings.content.loginTitle,
    previewLoginSubtitle: settings.content.loginSubtitle,
    previewLoginButtonLabel: settings.content.loginButtonLabel,
    previewRegisterButtonLabel: settings.content.registerButtonLabel,
    previewCancelLabel: settings.content.cancelLabel,
    previewTasksDashboardTitle: settings.content.tasksDashboardTitle,
    previewTasksDashboardCaption: settings.content.tasksDashboardCaption,
    previewLearningRoleTrackLabel: settings.content.learningRoleTrackLabel,
    previewLearningRoleTrackItems: JSON.stringify(settings.content.learningRoleTrackItems),
    previewLearningUrgentTitle: settings.content.learningUrgentTitle,
    previewLearningUrgentEmptyText: settings.content.learningUrgentEmptyText,
    previewLearningTheoryTitle: settings.content.learningTheoryTitle,
    previewLearningTestsTitle: settings.content.learningTestsTitle,
    previewLearningDefaultSectionLabel: settings.content.learningDefaultSectionLabel,
    previewLearningEmptyTheoryText: settings.content.learningEmptyTheoryText,
    previewLearningEmptyTestsText: settings.content.learningEmptyTestsText,
    previewAdminTitle: settings.content.adminTitle,
    previewAdminSubtitle: settings.content.adminSubtitle,
    previewProfileTitle: settings.content.profileTitle,
    previewProfileSubtitle: settings.content.profileSubtitle,
    previewNavHomeLabel: settings.content.navHomeLabel,
    previewNavTasksLabel: settings.content.navTasksLabel,
    previewNavAdminLabel: settings.content.navAdminLabel,
    previewNavProfileLabel: settings.content.navProfileLabel
  };

  const layoutParams: Record<string, string> = {
    previewDensity: settings.layout.density,
    previewCardRadiusPx: String(settings.layout.cardRadiusPx),
    previewSectionGapPx: String(settings.layout.sectionGapPx),
    previewHomeCtaOffsetX: String(settings.layout.homeCtaOffsetX),
    previewHomeCtaOffsetY: String(settings.layout.homeCtaOffsetY),
    previewHomeCtaAlign: settings.layout.homeCtaAlign,
    previewHomeSectionOrder: JSON.stringify(settings.layout.homeSectionOrder),
    previewHomeFeatureCardOrder: JSON.stringify(settings.layout.homeFeatureCardOrder)
  };

  const componentParams: Record<string, string> = {
    previewShowHomeCta: settings.components.showHomeCta ? "1" : "0",
    previewSmoothTabs: settings.components.smoothTabs ? "1" : "0",
    previewButtonShadow: settings.components.buttonShadow ? "1" : "0",
    previewElementOverrides: JSON.stringify(settings.elementOverrides)
  };

  Object.entries({
    ...themeParams,
    ...typographyParams,
    ...contentParams,
    ...layoutParams,
    ...componentParams
  }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
}

function buildRuntimeUrl(
  detail: DeployClientDetail,
  screen: PreviewScreen,
  brandName: string | null,
  tariff: string,
  industryTemplate: string,
  settings?: ClientPreviewSettings
): string {
  const url = new URL(screen.href, LOCAL_PREVIEW_ORIGIN);
  url.searchParams.set("previewClientId", detail.client.id);
  if (brandName !== null) url.searchParams.set("previewBrandName", brandName);
  url.searchParams.set("previewTariff", tariff);
  url.searchParams.set("previewIndustryTemplate", industryTemplate);
  url.searchParams.set("previewEditable", "1");
  // Embedded editing ships the draft by message, avoiding URL limits for long text and overrides.
  if (settings) addSettingsParams(url, settings);
  return `${url.pathname}${url.search}`;
}

function getNormalizedFeatureCardOrder(order: number[], cardCount: number): number[] {
  const normalizedOrder = order.filter((index) => index >= 0 && index < cardCount);

  Array.from({ length: cardCount }).forEach((_, index) => {
    if (!normalizedOrder.includes(index)) {
      normalizedOrder.push(index);
    }
  });

  return normalizedOrder;
}

function getEditableFeatureCards(
  industryCards: ClientPreviewFeatureCardContent[],
  savedCards: ClientPreviewFeatureCardContent[]
): ClientPreviewFeatureCardContent[] {
  return industryCards.map((card, index) => {
    const savedCard = savedCards[index];

    return {
      title: savedCard?.title?.trim() || card.title,
      desc: savedCard?.desc?.trim() || card.desc
    };
  });
}

function getEditableRoleTrackItems(industryItems: readonly string[], savedItems: string[]): string[] {
  return savedItems.length > 0 ? savedItems : [...industryItems];
}

function normalizeLearningSectionName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function getLearningSectionOptions(
  routeItems: LegacyRouteItem[],
  testItems: LegacyTestItem[]
): string[] {
  const sectionNames = new Set<string>();

  [...routeItems, ...testItems].forEach((item) => {
    const sectionName = normalizeLearningSectionName(String(item.section ?? ""));

    if (sectionName) {
      sectionNames.add(sectionName);
    }
  });

  return Array.from(sectionNames).sort((left, right) => left.localeCompare(right, "ru"));
}

function moveLearningItemWithinSection<T extends { section?: string }>(
  items: T[],
  selectedIndex: number,
  direction: -1 | 1
): { items: T[]; selectedIndex: number; moved: boolean } {
  const selectedItem = items[selectedIndex];

  if (!selectedItem) {
    return { items, selectedIndex, moved: false };
  }

  const selectedSection = normalizeLearningSectionName(selectedItem.section ?? "Основной раздел");
  const sectionIndexes = items
    .map((item, index) => ({
      index,
      section: normalizeLearningSectionName(item.section ?? "Основной раздел")
    }))
    .filter((item) => item.section === selectedSection)
    .map((item) => item.index);
  const positionInSection = sectionIndexes.indexOf(selectedIndex);
  const nextPositionInSection = positionInSection + direction;

  if (
    positionInSection < 0 ||
    nextPositionInSection < 0 ||
    nextPositionInSection >= sectionIndexes.length
  ) {
    return { items, selectedIndex, moved: false };
  }

  const nextSelectedIndex = sectionIndexes[nextPositionInSection];
  const nextItems = [...items];
  const currentItem = nextItems[selectedIndex];
  nextItems[selectedIndex] = nextItems[nextSelectedIndex];
  nextItems[nextSelectedIndex] = currentItem;

  return {
    items: nextItems,
    selectedIndex: nextSelectedIndex,
    moved: true
  };
}

function cloneLearningItems<T>(items: T[]): T[] {
  return JSON.parse(JSON.stringify(items)) as T[];
}

export function PreviewShell({
  detail,
  initialSettings,
  overrides
}: {
  detail: DeployClientDetail;
  initialSettings: ClientPreviewSettings;
  overrides: PreviewOverrides;
}): React.ReactElement {
  const [settings, setSettings] = useState<ClientPreviewSettings>(() => {
    const merged = mergeClientPreviewSettings(initialSettings);

    return mergeClientPreviewSettings({
      ...merged,
      theme: {
        ...merged.theme,
        primary: overrides.primary ?? detail.profile?.previewThemePrimary ?? merged.theme.primary,
        accent: overrides.accent ?? detail.profile?.previewThemeAccent ?? merged.theme.accent,
        background:
          overrides.background ?? detail.profile?.previewThemeBackground ?? merged.theme.background,
        surface: overrides.surface ?? detail.profile?.previewThemeSurface ?? merged.theme.surface,
        button: overrides.button ?? overrides.primary ?? detail.profile?.previewThemePrimary ?? merged.theme.button
      },
      content: {
        ...merged.content,
        homeTitle: overrides.brandName ?? merged.content.homeTitle ?? detail.client.brandName
      }
    });
  });
  const [activeTariff, setActiveTariff] = useState<string>(overrides.tariff ?? detail.client.tariff);
  const [activeIndustryTemplate, setActiveIndustryTemplate] = useState<string>(
    overrides.industryTemplate ?? detail.client.industryTemplate
  );
  const [activeScreenKey, setActiveScreenKey] = useState<string>("home");
  const [screenNavigation, setScreenNavigation] = useState(0);
  const [activeBrandName, setActiveBrandName] = useState<string>(
    overrides.brandName ?? detail.client.brandName
  );
  const [activeInspectorTab, setActiveInspectorTab] = useState<InspectorTab>("content");
  const [isFrameLoading, setIsFrameLoading] = useState(true);
  const [isEditorReady, setIsEditorReady] = useState(false);
  const [frameSyncError, setFrameSyncError] = useState("");
  const [frameResourceNote, setFrameResourceNote] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [isBrandImageUploading, setIsBrandImageUploading] = useState(false);
  const [brandImageMessage, setBrandImageMessage] = useState("");
  const [isLearningBusy, setIsLearningBusy] = useState(false);
  const [savedSettingsSnapshot, setSavedSettingsSnapshot] = useState(() => JSON.stringify(mergeClientPreviewSettings(initialSettings)));
  const [saveMessage, setSaveMessage] = useState("");
  const [isSelectMode, setIsSelectMode] = useState(true);
  const [isElementDragMode, setIsElementDragMode] = useState(false);
  const [isScreenRailOpen, setIsScreenRailOpen] = useState(true);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [selectedEditableId, setSelectedEditableId] = useState<string | null>(null);
  const [learningRouteItems, setLearningRouteItems] = useState<LegacyRouteItem[]>([]);
  const [learningTestItems, setLearningTestItems] = useState<LegacyTestItem[]>([]);
  const [learningRouteSnapshot, setLearningRouteSnapshot] = useState<LegacyRouteItem[]>([]);
  const [learningTestSnapshot, setLearningTestSnapshot] = useState<LegacyTestItem[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [selectedTestIndex, setSelectedTestIndex] = useState(0);
  const [newLearningSectionName, setNewLearningSectionName] = useState("");
  const [learningContentStatus, setLearningContentStatus] = useState<LearningContentStatus>("idle");
  const [learningContentMessage, setLearningContentMessage] = useState("");
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameReadyRef = useRef(false);
  const draftRevisionRef = useRef(0);
  const controlRevisionRef = useRef(0);
  const latestControlsRef = useRef<PreviewControlState | null>(null);
  const frameDeadlineRef = useRef(0);
  const latestDraftRef = useRef<Omit<PreviewDraft, "revision">>({ clientId: detail.client.id, brandName: activeBrandName, tariff: activeTariff, industryTemplate: activeIndustryTemplate, settings });
  const settingsEditRevisionRef = useRef(0);
  const learningEditRevisionRef = useRef(0);
  const settingsRequestRef = useRef<AbortController | null>(null);
  const brandImageRequestRef = useRef<AbortController | null>(null);
  const learningRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const editorStateRef = useRef<CoreEditorState>({ dirty: false, busy: false, blocked: true });

  const liveSiteUrl = getLiveSiteUrl(detail.profile);
  const flags = useMemo(() => getTariffFlags(activeTariff), [activeTariff]);
  const industryLabel = useMemo(
    () => getIndustryTemplateShortLabel(activeIndustryTemplate),
    [activeIndustryTemplate]
  );
  const industryContent = useMemo(
    () => getIndustryContent(activeIndustryTemplate),
    [activeIndustryTemplate]
  );
  const screens = useMemo<PreviewScreen[]>(
    () => [
      { key: "home", label: "Главная", href: "/", enabled: true },
      { key: "login", label: "Вход", href: "/login", enabled: true },
      { key: "welcome", label: "Кабинет", href: "/tasks?tab=welcome", enabled: true },
      { key: "edu", label: "Обучение", href: "/tasks?tab=edu", enabled: true },
      { key: "docs", label: "Документы", href: "/tasks?tab=docs", enabled: flags.documentTemplates },
      { key: "assortment", label: industryContent.assortmentLabel, href: "/tasks?tab=assortment", enabled: true },
      {
        key: "products",
        label: industryContent.productsLabel,
        href: "/tasks?tab=products",
        enabled: flags.branding || flags.advancedAnalytics
      },
      {
        key: "standards",
        label: industryContent.assistantLabel,
        href: "/tasks?tab=standards",
        enabled: flags.aiAssistant
      },
      { key: "admin", label: "Админка", href: "/admin", enabled: true },
      { key: "profile", label: "Профиль", href: "/profile", enabled: true }
    ],
    [flags, industryContent]
  );
  const activeScreen =
    screens.find((item) => item.key === activeScreenKey && item.enabled) ??
    screens.find((item) => item.enabled) ??
    screens[0];
  const runtimeUrl = buildRuntimeUrl(
    detail,
    activeScreen,
    null,
    activeTariff,
    activeIndustryTemplate
  );
  const [frameRuntimeUrl, setFrameRuntimeUrl] = useState(runtimeUrl);
  const navigationKey = `${detail.client.id}:${activeScreen.href}:${screenNavigation}`;
  const previousNavigationRef = useRef(navigationKey);
  const stableLocalClientUrl = `${LOCAL_PREVIEW_ORIGIN}/client/${detail.client.id}`;
  const selectedElementMeta = getEditableElementMeta(selectedEditableId);
  const selectedElementOverride = getClientPreviewElementOverride(settings, selectedEditableId);
  const selectedContentField = getContentFieldForEditableElement(selectedEditableId);
  const selectedContentFieldLabel = selectedContentField ? CONTENT_FIELD_LABELS[selectedContentField] : null;
  const normalizedFeatureCardOrder = getNormalizedFeatureCardOrder(
    settings.layout.homeFeatureCardOrder,
    industryContent.featureCards.length
  );
  const editableFeatureCards = getEditableFeatureCards(
    industryContent.featureCards,
    settings.content.homeFeatureCards
  );
  const editableRoleTrackItems = getEditableRoleTrackItems(
    industryContent.roleTrackItems,
    settings.content.learningRoleTrackItems
  );
  const selectedRouteItem = learningRouteItems[selectedRouteIndex] ?? null;
  const selectedTestItem = learningTestItems[selectedTestIndex] ?? null;
  const learningSectionOptions = getLearningSectionOptions(learningRouteItems, learningTestItems);
  const hasLearningDraftChanges = useMemo(
    () =>
      JSON.stringify(learningRouteItems) !== JSON.stringify(learningRouteSnapshot) ||
      JSON.stringify(learningTestItems) !== JSON.stringify(learningTestSnapshot),
    [learningRouteItems, learningRouteSnapshot, learningTestItems, learningTestSnapshot]
  );
  const hasSettingsDraftChanges = JSON.stringify(settings) !== savedSettingsSnapshot;

  useEffect(() => {
    editorStateRef.current = { dirty: hasSettingsDraftChanges || hasLearningDraftChanges, busy: isSettingsSaving || isLearningBusy || isBrandImageUploading, blocked: !isEditorReady };
  }, [hasSettingsDraftChanges, hasLearningDraftChanges, isSettingsSaving, isLearningBusy, isBrandImageUploading, isEditorReady]);

  useEffect(() => connectCoreEditorState(window, detail.client.id, () => editorStateRef.current), [detail.client.id]);

  useEffect(() => {
    mountedRef.current = true;
    setIsEditorReady(true);
    return () => {
      mountedRef.current = false;
      settingsRequestRef.current?.abort();
      brandImageRequestRef.current?.abort();
      learningRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!hasSettingsDraftChanges && !hasLearningDraftChanges && !isSettingsSaving && !isLearningBusy && !isBrandImageUploading) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasSettingsDraftChanges, hasLearningDraftChanges, isSettingsSaving, isLearningBusy, isBrandImageUploading]);

  useEffect(() => {
    if (previousNavigationRef.current === navigationKey) return;
    previousNavigationRef.current = navigationKey;
    const target = new URL(runtimeUrl, LOCAL_PREVIEW_ORIGIN);
    target.searchParams.set("previewEditorNavigation", String(screenNavigation));
    setFrameRuntimeUrl(`${target.pathname}${target.search}`);
  }, [navigationKey, runtimeUrl, screenNavigation]);

  useEffect(() => {
    frameReadyRef.current = false;
    setIsFrameLoading(true);
    setFrameSyncError("");
    setFrameResourceNote("");
    startFrameDeadline();
    return () => window.clearTimeout(frameDeadlineRef.current);
  }, [frameRuntimeUrl]);

  useEffect(() => {
    latestDraftRef.current = { clientId: detail.client.id, brandName: activeBrandName, tariff: activeTariff, industryTemplate: activeIndustryTemplate, settings };
    const frame = window.requestAnimationFrame(sendLatestDraft);
    return () => window.cancelAnimationFrame(frame);
  }, [detail.client.id, activeBrandName, activeTariff, activeIndustryTemplate, settings]);

  useEffect(() => {
    if (!selectedEditableId) {
      setIsElementDragMode(false);
    }
  }, [selectedEditableId]);

  useEffect(() => {
    if (activeInspectorTab === "learning" && learningContentStatus === "idle") {
      void loadLearningContent();
    }
  }, [activeInspectorTab, learningContentStatus]);

  useEffect(() => {
    setSelectedRouteIndex((current) => Math.min(current, Math.max(learningRouteItems.length - 1, 0)));
  }, [learningRouteItems.length]);

  useEffect(() => {
    setSelectedTestIndex((current) => Math.min(current, Math.max(learningTestItems.length - 1, 0)));
  }, [learningTestItems.length]);

  useEffect(() => {
    latestControlsRef.current = {
        selectMode: isSelectMode,
        dragMode: isElementDragMode,
        selectedId: selectedEditableId,
        primary: settings.theme.primary,
        accent: settings.theme.accent,
        buttonText: settings.theme.buttonText,
        textEditableIds: Object.keys(TEXT_EDITABLE_ELEMENT_CONTENT_FIELDS),
        elementOverrides: Object.fromEntries(Object.entries(settings.elementOverrides).map(([id, value]) => [id, { offsetX: value.offsetX, offsetY: value.offsetY }]))
      };
    const frame = window.requestAnimationFrame(sendLatestControls);
    return () => window.cancelAnimationFrame(frame);
  }, [
    detail.client.id,
    isElementDragMode,
    isSelectMode,
    selectedEditableId,
    settings.elementOverrides,
    settings.theme.accent,
    settings.theme.buttonText,
    settings.theme.primary
  ]);

  useEffect(() => {
    const messageHandler = (event: MessageEvent<PreviewRuntimeMessage>) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== window.location.origin || event.data?.source !== PREVIEW_RUNTIME_SOURCE || event.data.clientId !== latestDraftRef.current.clientId) {
        return;
      }

      if (event.data.type === "frame-ready") {
        frameReadyRef.current = true;
        setFrameSyncError("");
        setFrameResourceNote("");
        sendLatestDraft();
        sendLatestControls();
        return;
      }
      if (event.data.type === "draft-applied" && event.data.revision === draftRevisionRef.current) {
        window.clearTimeout(frameDeadlineRef.current);
        setIsFrameLoading(false);
        setFrameSyncError("");
        return;
      }
      if (event.data.type === "draft-rejected" && event.data.revision === draftRevisionRef.current) {
        window.clearTimeout(frameDeadlineRef.current);
        setIsFrameLoading(false);
        setFrameSyncError("Черновик не применен: проверьте значения настроек.");
        return;
      }

      if (event.data.type === "select-element" && event.data.elementId) {
        const meta = getEditableElementMeta(event.data.elementId);

        if (meta) {
          setSelectedEditableId(meta.id);
          setActiveInspectorTab("element");
        }

        return;
      }

      if (
        event.data.type === "edit-text" &&
        event.data.elementId &&
        typeof event.data.nextText === "string"
      ) {
        const contentField = getContentFieldForEditableElement(event.data.elementId);
        const nextText = event.data.nextText.trim();

        if (!contentField || !nextText) {
          return;
        }

        if (contentField === "homeTitle") {
          setActiveBrandName(nextText);
        }

        settingsEditRevisionRef.current++;
        setSaveState("idle");
        setSaveMessage("Текст изменен локально. Нажми `Сохранить`, чтобы записать настройку клиенту.");
        setSettings((current) =>
          mergeClientPreviewSettings({
            ...current,
            content: {
              ...current.content,
              [contentField]: nextText
            }
          })
        );

        return;
      }

      if (
        event.data.type === "move-element" &&
        event.data.elementId &&
        Number.isFinite(event.data.offsetX) &&
        Number.isFinite(event.data.offsetY)
      ) {
        settingsEditRevisionRef.current++;
        setSaveState("idle");
        setSettings((current) =>
          mergeClientPreviewSettings({
            ...current,
            elementOverrides: {
              ...current.elementOverrides,
              [event.data.elementId as string]: {
                ...getClientPreviewElementOverride(current, event.data.elementId as string),
                offsetX: Number(event.data.offsetX),
                offsetY: Number(event.data.offsetY)
              }
            }
          })
        );
      }
    };

    window.addEventListener("message", messageHandler);

    return () => window.removeEventListener("message", messageHandler);
  }, []);

  function sendLatestDraft(): void {
    if (!frameReadyRef.current || !frameRef.current?.contentWindow) return;
    frameRef.current.contentWindow.postMessage({ source: PREVIEW_EDITOR_SOURCE, type: "apply-draft", version: 1, ...latestDraftRef.current, revision: ++draftRevisionRef.current }, window.location.origin);
  }

  function sendLatestControls(): void {
    if (!frameReadyRef.current || !frameRef.current?.contentWindow || !latestControlsRef.current) return;
    frameRef.current.contentWindow.postMessage({ source: PREVIEW_EDITOR_SOURCE, type: "apply-controls", version: 1, clientId: latestDraftRef.current.clientId, revision: ++controlRevisionRef.current, control: latestControlsRef.current }, window.location.origin);
  }

  function navigateToScreen(key: string): void {
    setActiveScreenKey(key);
    setScreenNavigation((current) => current + 1);
  }

  function startFrameDeadline(): void {
    window.clearTimeout(frameDeadlineRef.current);
    frameDeadlineRef.current = window.setTimeout(() => {
      frameReadyRef.current = false;
      setIsFrameLoading(false);
      setFrameSyncError("LMS не ответила. Повторите загрузку или откройте главную.");
    }, 30000);
  }

  function frameLoaded(): void {
    frameReadyRef.current = false;
    try {
      const contentType = frameRef.current?.contentDocument?.contentType;
      if (frameRef.current?.contentWindow?.location.origin !== window.location.origin || (contentType && contentType !== "text/html")) {
        window.clearTimeout(frameDeadlineRef.current);
        setIsFrameLoading(false);
        setFrameSyncError("");
        setFrameResourceNote("Ресурс открыт для просмотра. Для редактирования вернитесь на главную LMS.");
        return;
      }
    } catch {
      window.clearTimeout(frameDeadlineRef.current);
      setIsFrameLoading(false);
      setFrameSyncError("");
      setFrameResourceNote("Ресурс открыт для просмотра. Для редактирования вернитесь на главную LMS.");
      return;
    }
    setIsFrameLoading(true);
    setFrameResourceNote("");
    startFrameDeadline();
    frameRef.current?.contentWindow?.postMessage({ source: PREVIEW_EDITOR_SOURCE, type: "request-ready", clientId: latestDraftRef.current.clientId }, window.location.origin);
  }

  function updateSettings(patch: Partial<ClientPreviewSettings>): void {
    settingsEditRevisionRef.current++;
    setSaveState("idle");
    setSettings((current) =>
      mergeClientPreviewSettings({
        ...current,
        ...patch,
        theme: {
          ...current.theme,
          ...(patch.theme ?? {})
        },
        typography: {
          ...current.typography,
          ...(patch.typography ?? {})
        },
        content: {
          ...current.content,
          ...(patch.content ?? {})
        },
        layout: {
          ...current.layout,
          ...(patch.layout ?? {})
        },
        components: {
          ...current.components,
          ...(patch.components ?? {})
        },
        elementOverrides: patch.elementOverrides ?? current.elementOverrides
      })
    );
  }

  async function uploadBrandImage(file: File): Promise<void> {
    if (brandImageRequestRef.current || settingsRequestRef.current) return;
    const controller = new AbortController(); brandImageRequestRef.current = controller;
    const deadline = window.setTimeout(() => controller.abort(), 20000);
    setIsBrandImageUploading(true); setBrandImageMessage("Проверка и загрузка изображения...");
    try {
      if (file.size > 4 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw Error("Нужен PNG, JPEG или WebP до 4 МБ.");
      const bitmap = await createImageBitmap(file);
      const valid = bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= 8192 && bitmap.height <= 8192 && bitmap.width * bitmap.height <= 16000000;
      bitmap.close(); if (!valid) throw Error("Слишком большое разрешение изображения (максимум 16 млн пикселей).");
      const response = await fetch(`/api/client-brand-assets?clientId=${encodeURIComponent(detail.client.id)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file, signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || payload.clientId !== detail.client.id || typeof payload.url !== "string") throw Error(payload.message || "Core не принял изображение.");
      if (!mountedRef.current) return;
      // Merge only the uploaded URL: text typed during upload must not be replaced by an older draft.
      settingsEditRevisionRef.current++; setSaveState("idle");
      setSettings((current) => mergeClientPreviewSettings({ ...current, content: { ...current.content, homeBackgroundImageUrl: payload.url } }));
      setBrandImageMessage("Файл загружен. Нажми «Сохранить», затем собери новый пакет установки.");
    } catch (error) {
      if (mountedRef.current) setBrandImageMessage(controller.signal.aborted ? "Загрузка отменена или истекло время ожидания." : error instanceof Error ? error.message : "Не удалось загрузить файл.");
    } finally {
      window.clearTimeout(deadline); if (brandImageRequestRef.current === controller) brandImageRequestRef.current = null;
      if (mountedRef.current) setIsBrandImageUploading(false);
    }
  }

  function updateSelectedElementOverride(patch: Partial<ClientPreviewElementOverride>): void {
    if (!selectedEditableId) {
      return;
    }

    updateSettings({
      elementOverrides: {
        ...settings.elementOverrides,
        [selectedEditableId]: {
          ...selectedElementOverride,
          ...patch
        }
      }
    });
  }

  function resetSelectedElementOverride(): void {
    if (!selectedEditableId) {
      return;
    }

    const nextElementOverrides = { ...settings.elementOverrides };
    delete nextElementOverrides[selectedEditableId];
    updateSettings({ elementOverrides: nextElementOverrides });
  }

  function moveHomeSection(section: ClientPreviewHomeSection, direction: -1 | 1): void {
    const currentOrder = [...settings.layout.homeSectionOrder];
    const currentIndex = currentOrder.indexOf(section);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= currentOrder.length) {
      return;
    }

    const [removedSection] = currentOrder.splice(currentIndex, 1);
    currentOrder.splice(nextIndex, 0, removedSection);
    updateSettings({
      layout: {
        ...settings.layout,
        homeSectionOrder: currentOrder
      }
    });
  }

  function moveHomeFeatureCard(cardIndex: number, direction: -1 | 1): void {
    const currentOrder = [...normalizedFeatureCardOrder];
    const currentIndex = currentOrder.indexOf(cardIndex);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= currentOrder.length) {
      return;
    }

    const [removedIndex] = currentOrder.splice(currentIndex, 1);
    currentOrder.splice(nextIndex, 0, removedIndex);
    updateSettings({
      layout: {
        ...settings.layout,
        homeFeatureCardOrder: currentOrder
      }
    });
  }

  function updateHomeFeatureCardContent(
    cardIndex: number,
    patch: Partial<ClientPreviewFeatureCardContent>
  ): void {
    const nextCards = getEditableFeatureCards(
      industryContent.featureCards,
      settings.content.homeFeatureCards
    );

    nextCards[cardIndex] = {
      ...nextCards[cardIndex],
      ...patch
    };

    updateSettings({
      content: {
        ...settings.content,
        homeFeatureCards: nextCards
      }
    });
  }

  function markLearningContentDirty(message = "Есть несохраненные изменения учебных материалов."): void {
    learningEditRevisionRef.current++;
    setLearningContentStatus("dirty");
    setLearningContentMessage(message);
  }

  async function loadLearningContent(): Promise<void> {
    if (learningRequestRef.current) return;
    if (hasLearningDraftChanges && !window.confirm("Загрузить сохраненные материалы заново? Несохраненные правки учебных материалов будут заменены.")) return;
    const controller = new AbortController();
    learningRequestRef.current = controller;
    const revision = learningEditRevisionRef.current;
    setIsLearningBusy(true);
    setLearningContentStatus("loading");
    setLearningContentMessage("Загружаю уроки и тесты клиента...");

    try {
      const payload = await requestPreviewJson<Record<string, unknown>>(
        `/api/storage?previewClientId=${encodeURIComponent(detail.client.id)}&keys=${encodeURIComponent("core_lms_route_v1,core_lms_tests_v1")}`,
        {
          cache: "no-store",
          signal: controller.signal
        }
      );

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new PreviewRequestError("invalid-response");
      const routeItems = Array.isArray(payload.core_lms_route_v1)
        ? (payload.core_lms_route_v1 as LegacyRouteItem[])
        : [];
      const testItems = Array.isArray(payload.core_lms_tests_v1)
        ? (payload.core_lms_tests_v1 as LegacyTestItem[])
        : [];

      if (!mountedRef.current) return;
      setLearningRouteSnapshot(cloneLearningItems(routeItems));
      setLearningTestSnapshot(cloneLearningItems(testItems));
      if (revision !== learningEditRevisionRef.current) {
        setLearningContentStatus("dirty");
        setLearningContentMessage("Сохраненная версия загружена, но новый ввод не заменен. В панели остался твой черновик.");
        return;
      }
      setLearningRouteItems(cloneLearningItems(routeItems));
      setLearningTestItems(cloneLearningItems(testItems));
      setLearningContentStatus("saved");
      setLearningContentMessage(`Загружено: уроков ${routeItems.length}, тестов ${testItems.length}.`);
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof PreviewRequestError && error.kind === "aborted") {
        setLearningContentStatus("idle");
        return;
      }
      setLearningContentStatus("error");
      setLearningContentMessage("Не удалось загрузить учебные материалы. Черновик не изменен. Проверь API и повтори загрузку.");
    } finally {
      if (learningRequestRef.current === controller) learningRequestRef.current = null;
      if (mountedRef.current) setIsLearningBusy(false);
    }
  }

  async function saveLearningContent(): Promise<void> {
    if (learningRequestRef.current) return;
    const confirmed = window.confirm(
      [
        "Сохранить учебные материалы клиента?",
        "",
        `Уроков: ${learningRouteItems.length}`,
        `Тестов: ${learningTestItems.length}`,
        "",
        "После сохранения эти данные попадут в backend клиента."
      ].join("\n")
    );

    if (!confirmed) {
      setLearningContentStatus("dirty");
      setLearningContentMessage("Сохранение отменено. Изменения остались только в панели.");
      return;
    }

    const controller = new AbortController();
    learningRequestRef.current = controller;
    const revision = learningEditRevisionRef.current;
    const submittedRoute = cloneLearningItems(learningRouteItems);
    const submittedTests = cloneLearningItems(learningTestItems);
    let routeSaved = false;
    setIsLearningBusy(true);
    setLearningContentStatus("saving");
    setLearningContentMessage("Сохраняю учебные материалы в backend...");

    try {
      await requestPreviewJson(
        `/api/storage?previewClientId=${encodeURIComponent(detail.client.id)}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            key: "core_lms_route_v1",
            data: submittedRoute
          })
        }
      );

      routeSaved = true;
      if (mountedRef.current) setLearningRouteSnapshot(cloneLearningItems(submittedRoute));
      await requestPreviewJson(
        `/api/storage?previewClientId=${encodeURIComponent(detail.client.id)}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            key: "core_lms_tests_v1",
            data: submittedTests
          })
        }
      );

      if (!mountedRef.current) return;
      setLearningTestSnapshot(cloneLearningItems(submittedTests));
      if (revision !== learningEditRevisionRef.current) {
        setLearningContentStatus("dirty");
        setLearningContentMessage("Отправленная версия сохранена. Более новые правки остались в панели; сохрани их отдельно.");
        return;
      }
      setLearningContentStatus("saved");
      setLearningContentMessage("Учебные материалы сохранены. Preview перезагружен.");
      setIsFrameLoading(true);
      frameRef.current?.contentWindow?.location.reload();
    } catch (error) {
      if (!mountedRef.current) return;
      setLearningContentStatus("error");
      setLearningContentMessage(routeSaved
        ? "Уроки сохранены. Сохранение тестов не подтверждено; черновик остался в панели. Проверь сохраненную версию перед повтором."
        : previewSaveFailureMessage(error));
    } finally {
      if (learningRequestRef.current === controller) learningRequestRef.current = null;
      if (mountedRef.current) setIsLearningBusy(false);
    }
  }

  function revertLearningContentDraft(): void {
    if (learningRequestRef.current) return;
    if (!hasLearningDraftChanges) {
      setLearningContentMessage("Откатывать нечего: черновик совпадает с последней версией.");
      return;
    }

    const confirmed = window.confirm(
      [
        "Откатить учебные материалы?",
        "",
        "Все несохраненные правки в редакторе будут удалены.",
        "Backend клиента не изменится."
      ].join("\n")
    );

    if (!confirmed) {
      setLearningContentStatus("dirty");
      setLearningContentMessage("Откат отменен. Черновик остался без изменений.");
      return;
    }

    const restoredRouteItems = cloneLearningItems(learningRouteSnapshot);
    const restoredTestItems = cloneLearningItems(learningTestSnapshot);

    learningEditRevisionRef.current++;
    setLearningRouteItems(restoredRouteItems);
    setLearningTestItems(restoredTestItems);
    setSelectedRouteIndex((current) => Math.min(current, Math.max(restoredRouteItems.length - 1, 0)));
    setSelectedTestIndex((current) => Math.min(current, Math.max(restoredTestItems.length - 1, 0)));
    setLearningContentStatus("saved");
    setLearningContentMessage("Откатил к последней загруженной или сохраненной версии.");
  }

  function updateSelectedRouteItem(patch: Partial<LegacyRouteItem>): void {
    if (!selectedRouteItem) {
      return;
    }

    setLearningRouteItems((current) =>
      current.map((item, index) => (index === selectedRouteIndex ? { ...item, ...patch } : item))
    );
    markLearningContentDirty();
  }

  function addLearningRouteItem(): void {
    const createdAt = Date.now();
    const nextItem: LegacyRouteItem = {
      id: `route_custom_${createdAt}`,
      title: "Новый урок",
      time: "5 мин",
      section: "Основной раздел",
      h1: "Заголовок урока",
      t1: "Добавь сюда основной текст урока.",
      h2: "",
      t2: "",
      h3: "",
      t3: ""
    };

    setLearningRouteItems((current) => [...current, nextItem]);
    setSelectedRouteIndex(learningRouteItems.length);
    setActiveScreenKey("edu");
    markLearningContentDirty("Создан новый урок. Заполни поля и нажми `Сохранить учебу`.");
  }

  function updateSelectedTestItem(patch: Partial<LegacyTestItem>): void {
    if (!selectedTestItem) {
      return;
    }

    setLearningTestItems((current) =>
      current.map((item, index) => (index === selectedTestIndex ? { ...item, ...patch } : item))
    );
    markLearningContentDirty();
  }

  function addLearningTestItem(): void {
    const createdAt = Date.now();
    const nextItem: LegacyTestItem = {
      id: `test_custom_${createdAt}`,
      title: "Новый тест",
      subtitle: "Проверка знаний",
      theory: "",
      section: "Основной раздел",
      timeLimit: 0,
      quiz: [
        {
          q: "Новый вопрос",
          o: ["Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4"],
          c: 0
        }
      ]
    };

    setLearningTestItems((current) => [...current, nextItem]);
    setSelectedTestIndex(learningTestItems.length);
    setActiveScreenKey("edu");
    markLearningContentDirty("Создан новый тест. Заполни вопросы и нажми `Сохранить учебу`.");
  }

  function assignSectionToSelectedRoute(sectionName: string): void {
    const normalizedSection = normalizeLearningSectionName(sectionName);

    if (!selectedRouteItem || !normalizedSection) {
      return;
    }

    updateSelectedRouteItem({ section: normalizedSection });
    setNewLearningSectionName("");
    markLearningContentDirty(`Урок перенесен в секцию "${normalizedSection}".`);
  }

  function assignSectionToSelectedTest(sectionName: string): void {
    const normalizedSection = normalizeLearningSectionName(sectionName);

    if (!selectedTestItem || !normalizedSection) {
      return;
    }

    updateSelectedTestItem({ section: normalizedSection });
    setNewLearningSectionName("");
    markLearningContentDirty(`Тест перенесен в секцию "${normalizedSection}".`);
  }

  function moveSelectedRouteItem(direction: -1 | 1): void {
    const result = moveLearningItemWithinSection(learningRouteItems, selectedRouteIndex, direction);

    if (!result.moved) {
      return;
    }

    setLearningRouteItems(result.items);
    setSelectedRouteIndex(result.selectedIndex);
    markLearningContentDirty("Порядок уроков в секции изменен. Нажми `Сохранить учебу`.");
  }

  function moveSelectedTestItem(direction: -1 | 1): void {
    const result = moveLearningItemWithinSection(learningTestItems, selectedTestIndex, direction);

    if (!result.moved) {
      return;
    }

    setLearningTestItems(result.items);
    setSelectedTestIndex(result.selectedIndex);
    markLearningContentDirty("Порядок тестов в секции изменен. Нажми `Сохранить учебу`.");
  }

  function updateSelectedTestQuestion(
    questionIndex: number,
    patch: Partial<LegacyQuizQuestion>
  ): void {
    if (!selectedTestItem) {
      return;
    }

    const currentQuiz = selectedTestItem.quiz ?? [];
    const nextQuiz = currentQuiz.map((question, index) =>
      index === questionIndex ? { ...question, ...patch } : question
    );

    updateSelectedTestItem({ quiz: nextQuiz });
  }

  function updateSelectedTestQuestionOption(
    questionIndex: number,
    optionIndex: number,
    value: string
  ): void {
    const question = selectedTestItem?.quiz?.[questionIndex];

    if (!question) {
      return;
    }

    const nextOptions = [...question.o];
    nextOptions[optionIndex] = value;
    updateSelectedTestQuestion(questionIndex, { o: nextOptions });
  }

  function addQuestionToSelectedTest(): void {
    if (!selectedTestItem) {
      return;
    }

    updateSelectedTestItem({
      quiz: [
        ...(selectedTestItem.quiz ?? []),
        {
          q: "Новый вопрос",
          o: ["Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4"],
          c: 0
        }
      ]
    });
  }

  function removeQuestionFromSelectedTest(questionIndex: number): void {
    if (!selectedTestItem) {
      return;
    }

    updateSelectedTestItem({
      quiz: (selectedTestItem.quiz ?? []).filter((_, index) => index !== questionIndex)
    });
  }

  async function saveSettings(): Promise<void> {
    if (settingsRequestRef.current || brandImageRequestRef.current) return;
    const controller = new AbortController();
    settingsRequestRef.current = controller;
    const revision = settingsEditRevisionRef.current;
    setIsSettingsSaving(true);
    setSaveState("saving");
    setSaveMessage("Сохраняю настройки...");

    try {
      const payload = await requestPreviewJson<{ settings: ClientPreviewSettings }>("/api/preview-settings", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          clientId: detail.client.id,
          theme: settings.theme,
          typography: settings.typography,
          content: settings.content,
          layout: settings.layout,
          components: settings.components,
          elementOverrides: settings.elementOverrides
        })
      });

      if (!payload?.settings || typeof payload.settings !== "object" || Array.isArray(payload.settings)) throw new PreviewRequestError("invalid-response");
      if (!mountedRef.current) return;
      const saved = mergeClientPreviewSettings(payload.settings);
      setSavedSettingsSnapshot(JSON.stringify(saved));
      if (revision !== settingsEditRevisionRef.current) {
        setSaveState("idle");
        setSaveMessage("Отправленная версия сохранена. Более новые правки остались в панели; нажми «Сохранить» еще раз.");
        return;
      }
      setSettings(saved);
      setSaveState("saved");
      setSaveMessage("Настройки сохранены и будут применяться к этому клиенту.");
    } catch (error) {
      if (!mountedRef.current) return;
      setSaveState("error");
      setSaveMessage(previewSaveFailureMessage(error));
    } finally {
      if (settingsRequestRef.current === controller) settingsRequestRef.current = null;
      if (mountedRef.current) setIsSettingsSaving(false);
    }
  }

  function discardEditorDraft(): void {
    if (settingsRequestRef.current || learningRequestRef.current || (!hasSettingsDraftChanges && !hasLearningDraftChanges)) return;
    if (!window.confirm("Отменить несохраненные правки оформления и учебных материалов? Уже сохраненные данные клиента не изменятся.")) return;
    settingsEditRevisionRef.current++;
    learningEditRevisionRef.current++;
    setSettings(mergeClientPreviewSettings(JSON.parse(savedSettingsSnapshot)));
    setActiveBrandName(detail.client.brandName);
    setLearningRouteItems(cloneLearningItems(learningRouteSnapshot));
    setLearningTestItems(cloneLearningItems(learningTestSnapshot));
    setSaveState("idle");
    setSaveMessage("Локальные правки отменены. Данные клиента не изменены.");
    setLearningContentStatus("idle");
    setLearningContentMessage("");
  }

  function resetSettings(): void {
    if (settingsRequestRef.current) return;
    if (hasSettingsDraftChanges && !window.confirm("Сбросить оформление? Несохраненные правки будут заменены. Сохраненная версия клиента не изменится до нажатия «Сохранить».")) return;
    settingsEditRevisionRef.current++;
    setSettings(
      mergeClientPreviewSettings({
        ...DEFAULT_CLIENT_PREVIEW_SETTINGS,
        theme: {
        ...DEFAULT_CLIENT_PREVIEW_SETTINGS.theme,
          primary: detail.profile?.previewThemePrimary ?? DEFAULT_CLIENT_PREVIEW_SETTINGS.theme.primary
        },
        content: {
          ...DEFAULT_CLIENT_PREVIEW_SETTINGS.content,
          homeTitle: detail.client.brandName
        }
      })
    );
    setSaveState("idle");
    setSaveMessage("Сброшено локально. Нажми сохранение, чтобы применить сброс к клиенту.");
  }

  return (
    <main className="preview-builder" data-editor-ready={isEditorReady ? "true" : "false"} inert={!isEditorReady} aria-busy={!isEditorReady} style={{ "--accent": settings.theme.accent, "--primary": settings.theme.primary } as React.CSSProperties}>
      <header className="builder-topbar">
        <div className="brand-block">
          <strong>{activeBrandName}</strong>
          <small>{flags.label} • {industryLabel}</small>
        </div>

        <div className="top-actions">
          <button type="button" onClick={() => setIsScreenRailOpen((current) => !current)}>
            {isScreenRailOpen ? "Скрыть страницы" : "Страницы"}
          </button>
          <button type="button" onClick={() => setIsInspectorOpen((current) => !current)}>
            {isInspectorOpen ? "Скрыть настройки" : "Настройки"}
          </button>
          <button
            type="button"
            className={isSelectMode ? "select-mode active" : "select-mode"}
            onClick={() => setIsSelectMode((current) => !current)}
          >
            {isSelectMode ? "Выбор включен" : "Выбрать элемент"}
          </button>
          <button type="button" onClick={() => navigateToScreen("home")}>
            Главная
          </button>
          <button type="button" className="primary-action" disabled={isSettingsSaving || isBrandImageUploading} onClick={() => void saveSettings()}>
            {isSettingsSaving ? "Сохранение..." : "Сохранить"}
          </button>
          <button type="button" disabled={isSettingsSaving || isLearningBusy || isBrandImageUploading || (!hasSettingsDraftChanges && !hasLearningDraftChanges)} onClick={discardEditorDraft}>
            Отменить правки
          </button>
        </div>
      </header>

      <section className={`builder-layout ${isScreenRailOpen ? "with-pages" : "without-pages"} ${isInspectorOpen ? "with-inspector" : "without-inspector"}`}>
        {isScreenRailOpen ? <aside className="screen-rail">
          <div className="rail-title">Страницы</div>
          {screens.map((screen) => (
            <button
              key={screen.key}
              type="button"
              disabled={!screen.enabled}
              className={screen.key === activeScreen.key ? "active" : ""}
              onClick={() => navigateToScreen(screen.key)}
            >
              {screen.label}
            </button>
          ))}

          <div className="rail-meta">
            <span>{flags.label}</span>
            <span>{industryLabel}</span>
            <span>{editableRoleTrackItems.join(" / ")}</span>
          </div>
        </aside> : null}

        <section className="preview-stage">
          <div className="stage-toolbar">
            <div>
              <strong>{activeScreen.label}</strong>
              <small>
                {selectedElementMeta
                  ? `Выбрано: ${selectedElementMeta.label}`
                  : isSelectMode
                    ? "Кликни по подсвеченному элементу в LMS"
                    : "Режим просмотра: ссылки и кнопки LMS работают как на сайте"}
              </small>
            </div>
            <span className={frameSyncError ? "frame-status error" : isFrameLoading ? "frame-status loading" : "frame-status"} title={frameSyncError || frameResourceNote} role="status">
              {!isEditorReady ? "Подготовка редактора..." : frameSyncError ? "Ошибка превью" : frameResourceNote ? "Просмотр ресурса" : isFrameLoading ? "Загрузка..." : "Готово"}
            </span>
            {frameSyncError ? <button type="button" onClick={() => navigateToScreen(activeScreen.key)}>Повторить загрузку</button> : null}
          </div>

          <div className="runtime-frame-wrap">
          <iframe
            ref={frameRef}
            className={isFrameLoading ? "runtime-frame loading" : "runtime-frame"}
            src={frameRuntimeUrl}
            title={`LMS preview ${detail.client.name}`}
            onLoad={frameLoaded}
            onError={() => { window.clearTimeout(frameDeadlineRef.current); frameReadyRef.current = false; setIsFrameLoading(false); setFrameSyncError("Не удалось загрузить LMS. Повторите попытку."); }}
          />
          {isFrameLoading ? <div className="frame-loading-cover" role="status"><span>Загрузка LMS...</span></div> : null}
          </div>
        </section>

        {isInspectorOpen ? <aside className="inspector">
          <div className={selectedElementMeta ? "selected-element active" : "selected-element"}>
            <span>{selectedElementMeta ? "Выбран элемент" : "Элемент не выбран"}</span>
            <strong>{selectedElementMeta?.label ?? "Включи выбор и кликни по LMS"}</strong>
            <p>
              {selectedElementMeta?.note ??
                "В режиме выбора клики по подсвеченным зонам не переходят по ссылкам, а выбирают элемент для настройки."}
            </p>
          </div>

          <div className="inspector-tabs">
            {([
              ["content", "Текст"],
              ["learning", "Учеба"],
              ["colors", "Цвета"],
              ["typography", "Шрифты"],
              ["element", "Блок"],
              ["layout", "Кнопки"],
              ["launch", "Запуск"]
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={activeInspectorTab === key ? "active" : ""}
                onClick={() => setActiveInspectorTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {activeInspectorTab === "content" ? (
            <div className="inspector-panel">
              <Field label="Название клиента">
                <input
                  value={activeBrandName}
                  onChange={(event) => {
                    setActiveBrandName(event.target.value);
                    updateSettings({ content: { ...settings.content, homeTitle: event.target.value } });
                  }}
                />
              </Field>
              <Field label="Бейдж на главной">
                <input
                  value={settings.content.homeBadge}
                  onChange={(event) => updateSettings({ content: { ...settings.content, homeBadge: event.target.value } })}
                />
              </Field>
              <Field label="Главный заголовок">
                <input
                  value={settings.content.homeTitle}
                  onChange={(event) => updateSettings({ content: { ...settings.content, homeTitle: event.target.value } })}
                />
              </Field>
              <Field label="Подзаголовок">
                <textarea
                  value={settings.content.homeSubtitle}
                  rows={4}
                  onChange={(event) => updateSettings({ content: { ...settings.content, homeSubtitle: event.target.value } })}
                />
              </Field>
              <Field label="Текст CTA-кнопки">
                <input
                  value={settings.content.primaryCtaLabel}
                  onChange={(event) =>
                    updateSettings({ content: { ...settings.content, primaryCtaLabel: event.target.value } })
                  }
                />
              </Field>
              <div className="feature-card-editor">
                <div>
                  <strong>Карточки преимуществ</strong>
                  <p>Эти тексты сохраняются в настройках клиента и попадут в локальную LMS-страницу.</p>
                </div>
                {editableFeatureCards.map((card, cardIndex) => (
                  <div key={cardIndex} className="feature-card-editor-item">
                    <Field label={`Карточка ${cardIndex + 1}: заголовок`}>
                      <input
                        value={card.title}
                        onChange={(event) =>
                          updateHomeFeatureCardContent(cardIndex, { title: event.target.value })
                        }
                      />
                    </Field>
                    <Field label={`Карточка ${cardIndex + 1}: описание`}>
                      <textarea
                        value={card.desc}
                        rows={3}
                        onChange={(event) =>
                          updateHomeFeatureCardContent(cardIndex, { desc: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                ))}
              </div>
              <Field label="Заголовок формы входа">
                <input
                  value={settings.content.loginTitle}
                  onChange={(event) =>
                    updateSettings({ content: { ...settings.content, loginTitle: event.target.value } })
                  }
                />
              </Field>
              <Field label="Подзаголовок формы входа">
                <input
                  value={settings.content.loginSubtitle}
                  onChange={(event) =>
                    updateSettings({ content: { ...settings.content, loginSubtitle: event.target.value } })
                  }
                />
              </Field>
              <Field label="Кнопка входа">
                <input
                  value={settings.content.loginButtonLabel}
                  onChange={(event) =>
                    updateSettings({ content: { ...settings.content, loginButtonLabel: event.target.value } })
                  }
                />
              </Field>
              <Field label="Кнопка регистрации">
                <input
                  value={settings.content.registerButtonLabel}
                  onChange={(event) =>
                    updateSettings({ content: { ...settings.content, registerButtonLabel: event.target.value } })
                  }
                />
              </Field>
              <Field label="Заголовок кабинета">
                <input
                  value={settings.content.tasksDashboardTitle}
                  onChange={(event) =>
                    updateSettings({ content: { ...settings.content, tasksDashboardTitle: event.target.value } })
                  }
                />
              </Field>
              <div className="learning-copy-editor">
                <div>
                  <strong>Учебные разделы</strong>
                  <p>Меняются только подписи и пустые состояния. Реальные разделы уроков и тестов не переименовываются.</p>
                </div>
                <Field label="Заголовок срочных заданий">
                  <input
                    value={settings.content.learningUrgentTitle}
                    onChange={(event) =>
                      updateSettings({
                        content: {
                          ...settings.content,
                          learningUrgentTitle: event.target.value
                        }
                      })
                    }
                  />
                </Field>
                <Field label="Пусто: срочные задания">
                  <textarea
                    value={settings.content.learningUrgentEmptyText}
                    rows={2}
                    onChange={(event) =>
                      updateSettings({
                        content: {
                          ...settings.content,
                          learningUrgentEmptyText: event.target.value
                        }
                      })
                    }
                  />
                </Field>
                <Field label="Заголовок теории">
                  <input
                    value={settings.content.learningTheoryTitle}
                    onChange={(event) =>
                      updateSettings({
                        content: {
                          ...settings.content,
                          learningTheoryTitle: event.target.value
                        }
                      })
                    }
                  />
                </Field>
                <Field label="Заголовок тестов">
                  <input
                    value={settings.content.learningTestsTitle}
                    onChange={(event) =>
                      updateSettings({
                        content: {
                          ...settings.content,
                          learningTestsTitle: event.target.value
                        }
                      })
                    }
                  />
                </Field>
                <Field label="Название основного раздела">
                  <input
                    value={settings.content.learningDefaultSectionLabel}
                    onChange={(event) =>
                      updateSettings({
                        content: {
                          ...settings.content,
                          learningDefaultSectionLabel: event.target.value
                        }
                      })
                    }
                  />
                </Field>
                <Field label="Пусто: теория">
                  <textarea
                    value={settings.content.learningEmptyTheoryText}
                    rows={2}
                    onChange={(event) =>
                      updateSettings({
                        content: {
                          ...settings.content,
                          learningEmptyTheoryText: event.target.value
                        }
                      })
                    }
                  />
                </Field>
                <Field label="Пусто: тесты">
                  <textarea
                    value={settings.content.learningEmptyTestsText}
                    rows={2}
                    onChange={(event) =>
                      updateSettings({
                        content: {
                          ...settings.content,
                          learningEmptyTestsText: event.target.value
                        }
                      })
                    }
                  />
                </Field>
              </div>
            </div>
          ) : null}

          {activeInspectorTab === "learning" ? (
            <div className="inspector-panel">
              <div className="learning-content-editor">
                <div className="learning-content-head">
                  <div>
                    <strong>Учебный контент клиента</strong>
                    <p>Редактирует реальные уроки и тесты клиента через backend-связанный `/api/storage`.</p>
                  </div>
                  <div className="learning-content-actions">
                    <button
                      type="button"
                      className="soft-action"
                      disabled={isLearningBusy}
                      onClick={() => void loadLearningContent()}
                    >
                      Обновить
                    </button>
                    <button
                      type="button"
                      className="soft-action"
                      disabled={
                        isLearningBusy ||
                        !hasLearningDraftChanges
                      }
                      onClick={revertLearningContentDraft}
                    >
                      Откатить
                    </button>
                    <button
                      type="button"
                      className="primary-mini-action"
                      disabled={isLearningBusy}
                      onClick={() => void saveLearningContent()}
                    >
                      {isLearningBusy ? "Подождите..." : "Сохранить учебу"}
                    </button>
                  </div>
                </div>

                <div className={`learning-content-status ${learningContentStatus}`}>
                  {learningContentMessage || "Открой вкладку, чтобы загрузить учебные материалы клиента."}
                </div>

                <div className="learning-content-counters">
                  <span>Уроков: {learningRouteItems.length}</span>
                  <span>Тестов: {learningTestItems.length}</span>
                  <span>Черновик: {hasLearningDraftChanges ? "есть" : "нет"}</span>
                </div>
              </div>

              <div className="learning-content-editor">
                <div>
                  <strong>Секции</strong>
                  <p>Секция создается только через назначение уроку или тесту. Пустых скрытых секций больше не добавляем.</p>
                </div>
                <div className="learning-section-list">
                  {learningSectionOptions.length > 0 ? (
                    learningSectionOptions.map((sectionName) => (
                      <button
                        key={sectionName}
                        type="button"
                        onClick={() => setNewLearningSectionName(sectionName)}
                      >
                        {sectionName}
                      </button>
                    ))
                  ) : (
                    <span>Секций пока нет</span>
                  )}
                </div>
                <Field label="Новая или выбранная секция">
                  <input
                    value={newLearningSectionName}
                    placeholder="Например: Бариста-кассир"
                    onChange={(event) => setNewLearningSectionName(event.target.value)}
                  />
                </Field>
                <div className="learning-section-actions">
                  <button
                    type="button"
                    className="soft-action"
                    disabled={!selectedRouteItem || !newLearningSectionName.trim()}
                    onClick={() => assignSectionToSelectedRoute(newLearningSectionName)}
                  >
                    Назначить уроку
                  </button>
                  <button
                    type="button"
                    className="soft-action"
                    disabled={!selectedTestItem || !newLearningSectionName.trim()}
                    onClick={() => assignSectionToSelectedTest(newLearningSectionName)}
                  >
                    Назначить тесту
                  </button>
                </div>
              </div>

              <div className="learning-content-editor">
                <div className="learning-section-head">
                  <div>
                    <strong>Уроки</strong>
                    <p>Меняй клиентский текст темы. ID скрыт, чтобы не сломать связь с прогрессом.</p>
                  </div>
                  <button type="button" className="soft-action" onClick={addLearningRouteItem}>
                    Создать урок
                  </button>
                </div>

                {learningRouteItems.length > 0 ? (
                  <>
                    <Field label="Выбрать урок">
                      <select
                        value={selectedRouteIndex}
                        onChange={(event) => setSelectedRouteIndex(Number(event.target.value))}
                      >
                        {learningRouteItems.map((item, index) => (
                          <option key={`${item.id}-${index}`} value={index}>
                            {index + 1}. {item.title || item.h1 || item.id}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="learning-order-actions">
                      <button type="button" className="soft-action" onClick={() => moveSelectedRouteItem(-1)}>
                        Выше в секции
                      </button>
                      <button type="button" className="soft-action" onClick={() => moveSelectedRouteItem(1)}>
                        Ниже в секции
                      </button>
                    </div>

                    {selectedRouteItem ? (
                      <div className="learning-item-form">
                        <Field label="Название карточки урока">
                          <input
                            value={selectedRouteItem.title ?? ""}
                            onChange={(event) => updateSelectedRouteItem({ title: event.target.value })}
                          />
                        </Field>
                        <Field label="Раздел">
                          <input
                            value={selectedRouteItem.section ?? ""}
                            onChange={(event) => updateSelectedRouteItem({ section: event.target.value })}
                          />
                        </Field>
                        <Field label="Время">
                          <input
                            value={selectedRouteItem.time ?? ""}
                            onChange={(event) => updateSelectedRouteItem({ time: event.target.value })}
                          />
                        </Field>
                        <Field label="Заголовок 1">
                          <input
                            value={selectedRouteItem.h1 ?? ""}
                            onChange={(event) => updateSelectedRouteItem({ h1: event.target.value })}
                          />
                        </Field>
                        <Field label="Текст 1">
                          <textarea
                            value={selectedRouteItem.t1 ?? ""}
                            rows={4}
                            onChange={(event) => updateSelectedRouteItem({ t1: event.target.value })}
                          />
                        </Field>
                        <Field label="Заголовок 2">
                          <input
                            value={selectedRouteItem.h2 ?? ""}
                            onChange={(event) => updateSelectedRouteItem({ h2: event.target.value })}
                          />
                        </Field>
                        <Field label="Текст 2">
                          <textarea
                            value={selectedRouteItem.t2 ?? ""}
                            rows={4}
                            onChange={(event) => updateSelectedRouteItem({ t2: event.target.value })}
                          />
                        </Field>
                        <Field label="Заголовок 3">
                          <input
                            value={selectedRouteItem.h3 ?? ""}
                            onChange={(event) => updateSelectedRouteItem({ h3: event.target.value })}
                          />
                        </Field>
                        <Field label="Текст 3">
                          <textarea
                            value={selectedRouteItem.t3 ?? ""}
                            rows={4}
                            onChange={(event) => updateSelectedRouteItem({ t3: event.target.value })}
                          />
                        </Field>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="empty-panel">
                    <strong>Уроков пока нет</strong>
                    <p>Нажми `Создать урок`, чтобы добавить первый учебный материал вручную.</p>
                    <button type="button" className="soft-action" onClick={addLearningRouteItem}>
                      Создать первый урок
                    </button>
                  </div>
                )}
              </div>

              <div className="learning-content-editor">
                <div className="learning-section-head">
                  <div>
                    <strong>Тесты</strong>
                    <p>Тесты не генерируются из уроков. Их нужно создать вручную или импортировать из реального файла тестов.</p>
                  </div>
                  <button type="button" className="soft-action" onClick={addLearningTestItem}>
                    Создать тест
                  </button>
                </div>

                {learningTestItems.length > 0 ? (
                  <>
                    <Field label="Выбрать тест">
                      <select
                        value={selectedTestIndex}
                        onChange={(event) => setSelectedTestIndex(Number(event.target.value))}
                      >
                        {learningTestItems.map((item, index) => (
                          <option key={`${item.id}-${index}`} value={index}>
                            {index + 1}. {item.title || item.id}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="learning-order-actions">
                      <button type="button" className="soft-action" onClick={() => moveSelectedTestItem(-1)}>
                        Выше в секции
                      </button>
                      <button type="button" className="soft-action" onClick={() => moveSelectedTestItem(1)}>
                        Ниже в секции
                      </button>
                    </div>

                    {selectedTestItem ? (
                      <div className="learning-item-form">
                        <Field label="Название теста">
                          <input
                            value={selectedTestItem.title ?? ""}
                            onChange={(event) => updateSelectedTestItem({ title: event.target.value })}
                          />
                        </Field>
                        <Field label="Раздел">
                          <input
                            value={selectedTestItem.section ?? ""}
                            onChange={(event) => updateSelectedTestItem({ section: event.target.value })}
                          />
                        </Field>
                        <Field label="Подзаголовок">
                          <input
                            value={selectedTestItem.subtitle ?? ""}
                            onChange={(event) => updateSelectedTestItem({ subtitle: event.target.value })}
                          />
                        </Field>
                        <Field label="Теория перед тестом">
                          <textarea
                            value={selectedTestItem.theory ?? ""}
                            rows={4}
                            onChange={(event) => updateSelectedTestItem({ theory: event.target.value })}
                          />
                        </Field>
                        <Field label="Лимит времени, минут">
                          <input
                            type="number"
                            min={0}
                            value={selectedTestItem.timeLimit ?? 0}
                            onChange={(event) => updateSelectedTestItem({ timeLimit: Number(event.target.value) })}
                          />
                        </Field>

                        <div className="quiz-editor">
                          <div className="quiz-editor-head">
                            <strong>Вопросы</strong>
                            <button type="button" className="soft-action" onClick={addQuestionToSelectedTest}>
                              Добавить вопрос
                            </button>
                          </div>
                          {(selectedTestItem.quiz ?? []).map((question, questionIndex) => (
                            <div key={questionIndex} className="quiz-question-editor">
                              <Field label={`Вопрос ${questionIndex + 1}`}>
                                <textarea
                                  value={question.q}
                                  rows={2}
                                  onChange={(event) =>
                                    updateSelectedTestQuestion(questionIndex, { q: event.target.value })
                                  }
                                />
                              </Field>
                              {question.o.map((option, optionIndex) => (
                                <Field key={optionIndex} label={`Вариант ${optionIndex + 1}`}>
                                  <input
                                    value={option}
                                    onChange={(event) =>
                                      updateSelectedTestQuestionOption(
                                        questionIndex,
                                        optionIndex,
                                        event.target.value
                                      )
                                    }
                                  />
                                </Field>
                              ))}
                              <Field label="Правильный вариант">
                                <select
                                  value={question.c}
                                  onChange={(event) =>
                                    updateSelectedTestQuestion(questionIndex, { c: Number(event.target.value) })
                                  }
                                >
                                  {question.o.map((_, optionIndex) => (
                                    <option key={optionIndex} value={optionIndex}>
                                      {optionIndex + 1}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                              <button
                                type="button"
                                className="ghost-danger"
                                onClick={() => removeQuestionFromSelectedTest(questionIndex)}
                              >
                                Удалить вопрос
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="empty-panel">
                    <strong>В пилоте постоянных тестов нет</strong>
                    <p>Это нормальное состояние: ядро больше не создает тесты из уроков автоматически.</p>
                    <button type="button" className="soft-action" onClick={addLearningTestItem}>
                      Создать первый тест вручную
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {activeInspectorTab === "colors" ? (
            <div className="inspector-panel">
              <ColorField label="Основной цвет" value={settings.theme.primary} onChange={(value) => updateSettings({ theme: { ...settings.theme, primary: value } })} />
              <ColorField label="Акцент" value={settings.theme.accent} onChange={(value) => updateSettings({ theme: { ...settings.theme, accent: value } })} />
              <ColorField label="Фон" value={settings.theme.background} onChange={(value) => updateSettings({ theme: { ...settings.theme, background: value } })} />
              <ColorField label="Поверхность" value={settings.theme.surface} onChange={(value) => updateSettings({ theme: { ...settings.theme, surface: value } })} />
              <ColorField label="Кнопка" value={settings.theme.button} onChange={(value) => updateSettings({ theme: { ...settings.theme, button: value } })} />
              <ColorField label="Текст кнопки" value={settings.theme.buttonText} onChange={(value) => updateSettings({ theme: { ...settings.theme, buttonText: value } })} />
              <ColorField label="Основной текст" value={settings.theme.text} onChange={(value) => updateSettings({ theme: { ...settings.theme, text: value } })} />
              <ColorField label="Вторичный текст" value={settings.theme.muted} onChange={(value) => updateSettings({ theme: { ...settings.theme, muted: value } })} />
            </div>
          ) : null}

          {activeInspectorTab === "typography" ? (
            <div className="inspector-panel">
              <SelectField label="Шрифт заголовков" value={settings.typography.headingFont} onChange={(value) => updateSettings({ typography: { ...settings.typography, headingFont: value } })} />
              <SelectField label="Шрифт текста" value={settings.typography.bodyFont} onChange={(value) => updateSettings({ typography: { ...settings.typography, bodyFont: value } })} />
              <SelectField label="Шрифт кнопок" value={settings.typography.buttonFont} onChange={(value) => updateSettings({ typography: { ...settings.typography, buttonFont: value } })} />
              <RangeField label="Размер базового текста" min={12} max={22} value={settings.typography.baseFontSizePx} onChange={(value) => updateSettings({ typography: { ...settings.typography, baseFontSizePx: value } })} />
              <RangeField label="Масштаб заголовка" min={0.7} max={1.6} step={0.05} value={settings.typography.headingScale} onChange={(value) => updateSettings({ typography: { ...settings.typography, headingScale: value } })} />
              <RangeField label="Размер текста кнопки" min={12} max={24} value={settings.typography.buttonFontSizePx} onChange={(value) => updateSettings({ typography: { ...settings.typography, buttonFontSizePx: value } })} />
            </div>
          ) : null}

          {activeInspectorTab === "element" ? (
            <div className="inspector-panel">
              {selectedElementMeta ? (
                <>
                  <div className="selected-element-editor">
                    <span>Настройка блока</span>
                    <strong>{selectedElementMeta.label}</strong>
                    <p>{selectedElementMeta.note}</p>
                    {selectedEditableId === "home.background" ? (
                      <div className="inline-text-editor">
                        <label>Ссылка на фоновое изображение</label>
                        <input
                          type="text"
                          disabled={isBrandImageUploading}
                          value={settings.content.homeBackgroundImageUrl}
                          placeholder="https://example.com/image.webp"
                          onChange={(event) =>
                            updateSettings({
                              content: {
                                ...settings.content,
                                homeBackgroundImageUrl: event.target.value
                              }
                            })
                          }
                        />
                        <label>Загрузить изображение</label>
                        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={isBrandImageUploading || isSettingsSaving} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadBrandImage(file); }} />
                        <small role="status">{brandImageMessage || "Картинка оформления будет доступна посетителям LMS. Не загружай сюда внутренние документы. Внешние ссылки не переносятся автоматически."}</small>
                      </div>
                    ) : selectedContentField ? (
                      <div className="inline-text-editor">
                        <label>{selectedContentFieldLabel}</label>
                        <textarea
                          value={settings.content[selectedContentField]}
                          rows={selectedContentField.includes("Subtitle") || selectedContentField.includes("Caption") ? 3 : 2}
                          onChange={(event) =>
                            updateSettings({
                              content: {
                                ...settings.content,
                                [selectedContentField]: event.target.value
                              }
                            })
                          }
                        />
                        <small>Можно также дважды кликнуть по этому тексту прямо в preview.</small>
                      </div>
                    ) : (
                      <small className="inline-text-hint">
                        У этого блока пока настраивается вид и позиция. Текстовые правки будут добавляться по мере подключения экрана.
                      </small>
                    )}
                  </div>

                  <label className="inline-checkbox">
                    <input
                      type="checkbox"
                      checked={isElementDragMode}
                      onChange={(event) => setIsElementDragMode(event.target.checked)}
                    />
                    Перемещать мышкой
                  </label>

                  <div className="drag-readout">
                    <span>X: {selectedElementOverride.offsetX}px</span>
                    <span>Y: {selectedElementOverride.offsetY}px</span>
                  </div>

                  <button
                    type="button"
                    className="soft-action"
                    onClick={() => updateSelectedElementOverride({ offsetX: 0, offsetY: 0 })}
                  >
                    Сбросить позицию
                  </button>

                  <label className="inline-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedElementOverride.visible}
                      onChange={(event) =>
                        updateSelectedElementOverride({ visible: event.target.checked })
                      }
                    />
                    Показывать блок
                  </label>

                  <RangeField
                    label="Ширина блока, %"
                    min={30}
                    max={100}
                    value={selectedElementOverride.widthPercent}
                    onChange={(value) => updateSelectedElementOverride({ widthPercent: value })}
                  />
                  <ChoiceField
                    label="Выравнивание"
                    value={selectedElementOverride.align}
                    options={[
                      ["center", "По центру"],
                      ["left", "Слева"],
                      ["right", "Справа"]
                    ]}
                    onChange={(value) =>
                      updateSelectedElementOverride({ align: value as ClientPreviewElementAlign })
                    }
                  />
                  <RangeField
                    label="Сдвиг по X"
                    min={-180}
                    max={180}
                    value={selectedElementOverride.offsetX}
                    onChange={(value) => updateSelectedElementOverride({ offsetX: value })}
                  />
                  <RangeField
                    label="Сдвиг по Y"
                    min={-180}
                    max={180}
                    value={selectedElementOverride.offsetY}
                    onChange={(value) => updateSelectedElementOverride({ offsetY: value })}
                  />
                  <RangeField
                    label="Отступ сверху"
                    min={0}
                    max={140}
                    value={selectedElementOverride.marginTopPx}
                    onChange={(value) => updateSelectedElementOverride({ marginTopPx: value })}
                  />
                  <RangeField
                    label="Отступ снизу"
                    min={0}
                    max={140}
                    value={selectedElementOverride.marginBottomPx}
                    onChange={(value) => updateSelectedElementOverride({ marginBottomPx: value })}
                  />
                  <RangeField
                    label="Внутренний отступ"
                    min={0}
                    max={90}
                    value={selectedElementOverride.paddingPx}
                    onChange={(value) => updateSelectedElementOverride({ paddingPx: value })}
                  />
                  <OptionalColorField
                    label="Цвет фона блока"
                    value={selectedElementOverride.backgroundColor}
                    fallback={settings.theme.surface}
                    onChange={(value) => updateSelectedElementOverride({ backgroundColor: value })}
                  />
                  <OptionalColorField
                    label="Цвет текста блока"
                    value={selectedElementOverride.textColor}
                    fallback={settings.theme.text}
                    onChange={(value) => updateSelectedElementOverride({ textColor: value })}
                  />
                  <OptionalColorField
                    label="Цвет рамки блока"
                    value={selectedElementOverride.borderColor}
                    fallback={settings.theme.primary}
                    onChange={(value) => updateSelectedElementOverride({ borderColor: value })}
                  />
                  <button type="button" className="ghost-danger" onClick={resetSelectedElementOverride}>
                    Сбросить настройки блока
                  </button>
                </>
              ) : (
                <div className="empty-panel">
                  <strong>Блок не выбран</strong>
                  <p>Нажми `Выбрать элемент`, затем кликни по подсвеченной зоне внутри LMS.</p>
                </div>
              )}
            </div>
          ) : null}

          {activeInspectorTab === "layout" ? (
            <div className="inspector-panel">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.components.showHomeCta}
                  onChange={(event) => updateSettings({ components: { ...settings.components, showHomeCta: event.target.checked } })}
                />
                Показывать CTA-кнопку на главной
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.components.smoothTabs}
                  onChange={(event) => updateSettings({ components: { ...settings.components, smoothTabs: event.target.checked } })}
                />
                Плавнее переключать вкладки
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.components.buttonShadow}
                  onChange={(event) => updateSettings({ components: { ...settings.components, buttonShadow: event.target.checked } })}
                />
                Тень у кнопки
              </label>
              <div className="section-order-editor">
                <div>
                  <strong>Порядок блоков главной</strong>
                  <p>Безопасный режим: меняется только порядок главного экрана и карточек преимуществ.</p>
                </div>
                {settings.layout.homeSectionOrder.map((section, index) => (
                  <div key={section} className="section-order-row">
                    <span>{index + 1}. {HOME_SECTION_LABELS[section]}</span>
                    <div>
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => moveHomeSection(section, -1)}
                      >
                        Выше
                      </button>
                      <button
                        type="button"
                        disabled={index === settings.layout.homeSectionOrder.length - 1}
                        onClick={() => moveHomeSection(section, 1)}
                      >
                        Ниже
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="section-order-editor">
                <div>
                  <strong>Порядок карточек преимуществ</strong>
                  <p>Меняется порядок карточек главной. Тексты редактируются во вкладке `Текст`.</p>
                </div>
                {normalizedFeatureCardOrder.map((cardIndex, index) => {
                  const card = editableFeatureCards[cardIndex];

                  return (
                    <div key={cardIndex} className="section-order-row">
                      <span>{index + 1}. {card?.title ?? `Карточка ${cardIndex + 1}`}</span>
                      <div>
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={() => moveHomeFeatureCard(cardIndex, -1)}
                        >
                          Выше
                        </button>
                        <button
                          type="button"
                          disabled={index === normalizedFeatureCardOrder.length - 1}
                          onClick={() => moveHomeFeatureCard(cardIndex, 1)}
                        >
                          Ниже
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <RangeField label="Сдвиг кнопки по X" min={-260} max={260} value={settings.layout.homeCtaOffsetX} onChange={(value) => updateSettings({ layout: { ...settings.layout, homeCtaOffsetX: value } })} />
              <RangeField label="Сдвиг кнопки по Y" min={-160} max={160} value={settings.layout.homeCtaOffsetY} onChange={(value) => updateSettings({ layout: { ...settings.layout, homeCtaOffsetY: value } })} />
              <RangeField label="Скругление кнопки" min={0} max={999} value={settings.typography.buttonRadiusPx} onChange={(value) => updateSettings({ typography: { ...settings.typography, buttonRadiusPx: value } })} />
              <RangeField label="Скругление карточек" min={8} max={64} value={settings.layout.cardRadiusPx} onChange={(value) => updateSettings({ layout: { ...settings.layout, cardRadiusPx: value } })} />
              <Field label="Выравнивание кнопки">
                <select
                  value={settings.layout.homeCtaAlign}
                  onChange={(event) =>
                    updateSettings({
                      layout: {
                        ...settings.layout,
                        homeCtaAlign: event.target.value as "left" | "center" | "right"
                      }
                    })
                  }
                >
                  <option value="left">Слева</option>
                  <option value="center">По центру</option>
                  <option value="right">Справа</option>
                </select>
              </Field>
            </div>
          ) : null}

          {activeInspectorTab === "launch" ? (
            <div className="inspector-panel">
              <Field label="Тариф">
                <select value={activeTariff} onChange={(event) => setActiveTariff(event.target.value)}>
                  <option value="base">Базовый</option>
                  <option value="extended">Расширенный</option>
                  <option value="corporate">Корпоративный</option>
                </select>
              </Field>
              <Field label="Отрасль">
                <select value={activeIndustryTemplate} onChange={(event) => setActiveIndustryTemplate(event.target.value)}>
                  {INDUSTRY_TEMPLATE_OPTIONS.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="launch-card">
                <strong>Локальный сайт клиента</strong>
                <p>{stableLocalClientUrl}</p>
                <a href={stableLocalClientUrl} target="_blank" rel="noreferrer">
                  Открыть короткий адрес
                </a>
              </div>
              {liveSiteUrl ? (
                <div className="launch-card">
                  <strong>Адрес host-профиля</strong>
                  <p>{liveSiteUrl}</p>
                </div>
              ) : null}
              <div className="launch-card muted">
                <strong>Если сайт не открылся</strong>
                <p>В Control Center нужно запустить сервис `lms-web`. Адрес редактора: {LOCAL_PREVIEW_ORIGIN}.</p>
              </div>
              <button type="button" disabled={isSettingsSaving} onClick={resetSettings}>
                Сбросить локально
              </button>
            </div>
          ) : null}

          {saveMessage ? <div className={`save-message ${saveState}`}>{saveMessage}</div> : null}
        </aside> : null}
      </section>

      <style jsx>{`
        .preview-builder {
          display: flex;
          flex-direction: column;
          position: fixed;
          inset: 0;
          z-index: 100;
          height: 100dvh;
          min-height: 0;
          width: 100%;
          overflow: hidden;
          background:
            radial-gradient(circle at top left, ${settings.theme.accent}24, transparent 26%),
            linear-gradient(145deg, #071015 0%, #10151d 48%, #070a0f 100%);
          color: #f5f7f6;
          font-family: Inter, Arial, sans-serif;
        }

        .preview-builder,
        .preview-builder * {
          box-sizing: border-box;
        }

        :global(html),
        :global(body) {
          width: 100%;
          height: 100%;
          overflow: hidden;
        }

        .builder-topbar {
          flex: 0 0 auto;
          min-height: 58px;
          height: auto;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 8px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(8, 13, 18, 0.88);
          backdrop-filter: blur(10px);
        }

        .brand-block {
          display: grid;
          gap: 2px;
          min-width: 0;
          flex: 0 1 180px;
        }

        .brand-block strong {
          font-size: 16px;
          line-height: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .brand-block small,
        .stage-toolbar small,
        .rail-meta {
          color: rgba(245, 247, 246, 0.58);
        }

        .top-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
          min-width: 0;
        }

        button,
        a {
          min-height: 34px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 9px;
          background: rgba(255, 255, 255, 0.05);
          color: #f5f7f6;
          padding: 0 11px;
          font-weight: 850;
          text-decoration: none;
          cursor: pointer;
        }

        button:disabled {
          opacity: 0.36;
          cursor: not-allowed;
        }

        .primary-action,
        .launch-card a {
          background: ${settings.theme.button};
          color: ${settings.theme.buttonText};
          border-color: transparent;
        }

        .select-mode.active {
          background: ${settings.theme.accent};
          color: #061015;
          border-color: transparent;
        }

        .builder-layout {
          flex: 1 1 0;
          min-height: 0;
          height: auto;
          display: grid;
          gap: 8px;
          padding: 8px;
        }

        .builder-layout.with-pages.with-inspector {
          grid-template-columns: 126px minmax(0, 1fr) 300px;
        }

        .builder-layout.without-pages.with-inspector {
          grid-template-columns: minmax(0, 1fr) 300px;
        }

        .builder-layout.with-pages.without-inspector {
          grid-template-columns: 126px minmax(0, 1fr);
        }

        .builder-layout.without-pages.without-inspector {
          grid-template-columns: minmax(0, 1fr);
        }

        .screen-rail,
        .inspector {
          scrollbar-width: none;
        }

        .screen-rail::-webkit-scrollbar,
        .inspector::-webkit-scrollbar {
          width: 0;
          height: 0;
        }

        .screen-rail,
        .inspector,
        .preview-stage {
          min-height: 0;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(10, 15, 21, 0.7);
          box-shadow: none;
        }

        .screen-rail,
        .inspector {
          overflow-x: hidden;
          overflow-y: auto;
          border-radius: 14px;
          padding: 9px;
        }

        .screen-rail {
          display: grid;
          align-content: start;
          gap: 8px;
        }

        .rail-title {
          color: rgba(245, 247, 246, 0.62);
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          margin-bottom: 4px;
        }

        .screen-rail button {
          width: 100%;
          justify-content: flex-start;
          text-align: left;
          white-space: normal;
          overflow-wrap: anywhere;
        }

        .screen-rail button.active,
        .inspector-tabs button.active {
          background: ${settings.theme.primary};
          color: ${settings.theme.buttonText};
          border-color: transparent;
        }

        .rail-meta {
          display: grid;
          gap: 6px;
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          font-size: 12px;
          line-height: 1.4;
        }

        .preview-stage {
          overflow: hidden;
          border-radius: 22px;
          display: grid;
          grid-template-rows: auto minmax(0, 1fr);
        }

        .stage-toolbar {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          align-items: center;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }

        .stage-toolbar div {
          display: grid;
          gap: 3px;
          min-width: 0;
        }

        .stage-toolbar small {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .frame-status {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 28px;
          padding: 0 10px;
          border-radius: 999px;
          background: rgba(52, 211, 153, 0.14);
          color: #86efac;
          font-size: 12px;
          font-weight: 900;
        }

        .frame-status.loading {
          background: rgba(251, 191, 36, 0.14);
          color: #fde68a;
        }

        .frame-status.error { background: rgba(239, 68, 68, 0.14); color: #fca5a5; }

        .runtime-frame {
          width: 100%;
          height: 100%;
          border: 0;
          background: #000;
          opacity: 1;
          transition: none;
        }

        .runtime-frame-wrap { position: relative; min-height: 0; height: 100%; }
        .frame-loading-cover { position: absolute; inset: 0; display: grid; place-items: center; background: #0b1117; color: #b7c6d5; font-size: 13px; }

        .runtime-frame.loading {
          opacity: 1;
        }

        .inspector-tabs {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 6px;
          margin-bottom: 12px;
        }

        .selected-element {
          display: grid;
          gap: 6px;
          padding: 12px;
          margin-bottom: 12px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .selected-element.active {
          border-color: ${settings.theme.primary}66;
          background: ${settings.theme.primary}12;
        }

        .selected-element span {
          color: ${settings.theme.accent};
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }

        .selected-element p {
          margin: 0;
          color: rgba(245, 247, 246, 0.62);
          font-size: 13px;
          line-height: 1.45;
        }

        .inspector-tabs button {
          min-height: 34px;
          padding: 0 8px;
          font-size: 12px;
        }

        .inspector-panel {
          display: grid;
          gap: 12px;
        }

        .field {
          display: grid;
          gap: 7px;
        }

        .field label,
        .range-head,
        .toggle-row {
          color: rgba(245, 247, 246, 0.72);
          font-size: 13px;
          font-weight: 800;
        }

        input,
        select,
        textarea {
          width: 100%;
          min-height: 40px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.05);
          color: #f5f7f6;
          padding: 0 10px;
          outline: none;
        }

        textarea {
          padding: 10px;
          resize: vertical;
          line-height: 1.45;
        }

        input[type="color"] {
          padding: 4px;
          cursor: pointer;
        }

        input[type="range"] {
          padding: 0;
          accent-color: ${settings.theme.primary};
        }

        .color-row {
          display: grid;
          grid-template-columns: 48px minmax(0, 1fr);
          gap: 8px;
          align-items: center;
        }

        .color-row.optional {
          grid-template-columns: 48px minmax(0, 1fr) auto;
        }

        .color-row.optional button,
        .ghost-danger,
        .soft-action {
          min-height: 40px;
          padding: 0 10px;
          font-size: 12px;
        }

        .soft-action {
          color: ${settings.theme.accent};
          border-color: ${settings.theme.accent}33;
          background: ${settings.theme.accent}12;
        }

        .ghost-danger {
          color: #fecdd3;
          border-color: rgba(254, 205, 211, 0.22);
          background: rgba(251, 113, 133, 0.08);
        }

        .range-head {
          display: flex;
          justify-content: space-between;
          gap: 8px;
        }

        .toggle-row,
        .inline-checkbox {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .toggle-row input,
        .inline-checkbox input {
          width: 18px;
          min-height: 18px;
          accent-color: ${settings.theme.primary};
        }

        .selected-element-editor,
        .empty-panel {
          display: grid;
          gap: 6px;
          padding: 12px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .selected-element-editor span {
          color: ${settings.theme.accent};
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }

        .selected-element-editor p,
        .empty-panel p {
          margin: 0;
          color: rgba(245, 247, 246, 0.62);
          font-size: 13px;
          line-height: 1.45;
        }

        .section-order-editor,
        .feature-card-editor,
        .role-track-editor,
        .learning-copy-editor,
        .learning-content-editor {
          display: grid;
          gap: 10px;
          padding: 12px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .section-order-editor strong,
        .feature-card-editor strong,
        .role-track-editor strong,
        .learning-copy-editor strong,
        .learning-content-editor strong {
          font-size: 13px;
        }

        .section-order-editor p,
        .feature-card-editor p,
        .role-track-editor p,
        .learning-copy-editor p,
        .learning-content-editor p {
          margin: 4px 0 0;
          color: rgba(245, 247, 246, 0.52);
          font-size: 12px;
          line-height: 1.4;
        }

        .feature-card-editor-item {
          display: grid;
          gap: 9px;
          padding: 10px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.07);
        }

        .learning-content-head,
        .learning-section-head,
        .quiz-editor-head {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: start;
        }

        .learning-section-head .soft-action {
          white-space: nowrap;
        }

        .learning-content-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: flex-end;
        }

        .primary-mini-action {
          min-height: 40px;
          padding: 0 12px;
          border-radius: 12px;
          border-color: transparent;
          background: ${settings.theme.primary};
          color: ${settings.theme.buttonText};
          font-size: 12px;
          font-weight: 900;
        }

        .learning-content-status {
          padding: 10px 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: rgba(245, 247, 246, 0.72);
          font-size: 12px;
          line-height: 1.4;
        }

        .learning-content-status.dirty {
          color: #fde68a;
          border-color: rgba(253, 230, 138, 0.26);
          background: rgba(251, 191, 36, 0.1);
        }

        .learning-content-status.saved {
          color: #86efac;
          border-color: rgba(134, 239, 172, 0.26);
          background: rgba(34, 197, 94, 0.09);
        }

        .learning-content-status.error {
          color: #fecdd3;
          border-color: rgba(254, 205, 211, 0.26);
          background: rgba(251, 113, 133, 0.09);
        }

        .learning-content-counters {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }

        .learning-content-counters span {
          min-height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.05);
          color: rgba(245, 247, 246, 0.78);
          font-size: 12px;
          font-weight: 900;
        }

        .learning-section-list {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .learning-section-list button,
        .learning-section-list span {
          min-height: 32px;
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 0 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: rgba(245, 247, 246, 0.76);
          font-size: 12px;
          font-weight: 800;
        }

        .learning-section-list button {
          cursor: pointer;
        }

        .learning-section-list button:hover {
          border-color: ${settings.theme.primary}66;
          color: #ffffff;
        }

        .learning-section-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }

        .learning-order-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }

        .learning-item-form,
        .quiz-editor,
        .quiz-question-editor {
          display: grid;
          gap: 10px;
        }

        .quiz-editor {
          padding-top: 8px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }

        .quiz-question-editor {
          padding: 10px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.07);
        }

        .role-track-list {
          display: grid;
          gap: 8px;
        }

        .role-track-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px;
        }

        .role-track-row button {
          min-height: 40px;
          padding: 0 10px;
          border-radius: 10px;
          color: #fecdd3;
          border-color: rgba(254, 205, 211, 0.2);
          background: rgba(251, 113, 133, 0.08);
          font-size: 12px;
        }

        .section-order-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px;
          align-items: center;
          min-height: 42px;
          padding: 8px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.04);
        }

        .section-order-row span {
          color: rgba(245, 247, 246, 0.82);
          font-size: 13px;
          font-weight: 900;
        }

        .section-order-row div {
          display: flex;
          gap: 6px;
        }

        .section-order-row button {
          min-height: 30px;
          padding: 0 8px;
          border-radius: 9px;
          font-size: 11px;
        }

        .inline-text-editor {
          display: grid;
          gap: 7px;
          margin-top: 6px;
        }

        .inline-text-editor label {
          color: rgba(245, 247, 246, 0.78);
          font-size: 12px;
          font-weight: 900;
        }

        .inline-text-editor small,
        .inline-text-hint {
          color: rgba(245, 247, 246, 0.52);
          font-size: 12px;
          line-height: 1.4;
        }

        .drag-readout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .drag-readout span {
          min-height: 38px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: rgba(245, 247, 246, 0.82);
          font-size: 13px;
          font-weight: 900;
        }

        .launch-card {
          display: grid;
          gap: 8px;
          padding: 12px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .launch-card p {
          margin: 0;
          color: rgba(245, 247, 246, 0.62);
          font-size: 13px;
          line-height: 1.45;
        }

        .launch-card.muted {
          opacity: 0.84;
        }

        .save-message {
          margin-top: 12px;
          padding: 10px 12px;
          border-radius: 14px;
          font-size: 13px;
          line-height: 1.45;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .save-message.saved {
          color: #86efac;
          border-color: rgba(134, 239, 172, 0.26);
        }

        .save-message.error {
          color: #fecdd3;
          border-color: rgba(254, 205, 211, 0.26);
        }

        @media (max-width: 1180px) {
          .builder-layout.with-pages.with-inspector {
            grid-template-columns: 112px minmax(0, 1fr) 270px;
          }

          .builder-topbar {
            flex-wrap: wrap;
          }

          .brand-block small {
            display: none;
          }
        }
      `}</style>
    </main>
  );
}

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <Field label={label}>
      <div className="color-row">
        <input type="color" value={value} onInput={(event) => onChange(event.currentTarget.value)} />
        <input value={value} onChange={(event) => onChange(event.target.value)} />
      </div>
    </Field>
  );
}

function OptionalColorField({
  label,
  value,
  fallback,
  onChange
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <Field label={label}>
      <div className="color-row optional">
        <input
          type="color"
          value={value || fallback}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
        <input
          value={value}
          placeholder="Пусто = наследовать"
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" onClick={() => onChange("")}>
          Очистить
        </button>
      </div>
    </Field>
  );
}

function SelectField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <Field label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {FONT_OPTIONS.map((font) => (
          <option key={font} value={font}>
            {font}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ChoiceField({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <Field label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </Field>
  );
}

function RangeField({
  label,
  min,
  max,
  step = 1,
  value,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
}): React.ReactElement {
  return (
    <div className="field">
      <div className="range-head">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
