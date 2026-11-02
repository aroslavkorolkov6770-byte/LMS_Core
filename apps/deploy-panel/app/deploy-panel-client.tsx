"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useDeferredValue, useEffect, useRef, useState, useTransition } from "react";
import { PanelOperationGate, panelRequestFailure, requestPanel, type PanelAction, type PanelOperation } from "./panel-request";
import { filterClients } from "./client-search";
import { CoreClientSelection } from "./core-client-selection";
import { InstallationAccessCard, ConnectionAccessFields, emptyConnectionAccess } from "./installation-access-card";
import { installationAccessRequest } from "./installation-access-channel";
import { extractClientIp, fillClientAddresses } from "./address-autofill";
import { buildLiveSiteUrl } from "./client-links";

import {
  DEFAULT_INDUSTRY_TEMPLATE,
  getIndustryTemplateShortLabel,
  INDUSTRY_TEMPLATE_OPTIONS
} from "./industry-options";

type DashboardSummary = {
  totalClients: number;
  activeClients: number;
  draftCount: number;
  validatedCount: number;
  readyToDeployCount: number;
  deployedCount: number;
};

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
  aiRequestsLimit: number | null;
  isActive: boolean;
  firstAdminEmail: string | null;
  readinessPercent: number;
  readyCount: number;
  pendingCount: number;
  deployStatus: string | null;
  deployStatusLabel: string;
  features: TariffFeatures;
};

type DeployChecklistItem = {
  code: string;
  label: string;
  status: "ready" | "pending";
  note: string;
};

type DeployValidationItem = {
  code: string;
  label: string;
  status: "passed" | "failed";
  note: string;
};

type DeployActivityItem = {
  id: string;
  action: string;
  title: string;
  note: string;
  createdAt: string;
};

type DeployRunStep = {
  code: string;
  label: string;
  note: string;
};

type DeployRunSummary = {
  hasRun: boolean;
  lastRunAt: string | null;
  status: string | null;
  stepCount: number;
  steps: DeployRunStep[];
};

type DeployHealthItem = {
  code: string;
  label: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  note: string;
};

type DeployHealthSummary = {
  overallStatus: "healthy" | "degraded" | "down";
  healthyCount: number;
  degradedCount: number;
  downCount: number;
  unknownCount: number;
  items: DeployHealthItem[];
};

type DeployHealthHistoryItem = {
  id: string;
  overallStatus: "healthy" | "degraded" | "down";
  createdAt: string;
  note: string;
};

type WorkspaceMode = "list" | "create" | "client" | "monitoring";

type DeployProfile = {
  id: string;
  clientId: string;
  hostUrl: string;
  deployPath: string | null;
  lmsSourcePath: string | null;
  deploymentBundlePath: string | null;
  databaseHost: string;
  databasePort: number;
  databaseName: string;
  databaseUser: string;
  databasePasswordSecretRef: string | null;
  storageBucket: string;
  storageRegion: string | null;
  storageEndpoint: string | null;
  storageSecretRef: string | null;
  aiProvider: string;
  aiModel: string;
  aiSecretRef: string | null;
  aliceTenantCode: string | null;
  aliceModelPreset: string | null;
  previewThemePrimary: string | null;
  previewThemeAccent: string | null;
  previewThemeBackground: string | null;
  previewThemeSurface: string | null;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

type DeployClientDetail = {
  client: DeployClientCard;
  adminCredentials: {
    clientAdminLogin: string | null;
    clientAdminPhone: string | null;
    clientAdminFirstName: string | null;
    clientAdminLastName: string | null;
    systemAdminLogin: string | null;
  };
  checklist: DeployChecklistItem[];
  profile: DeployProfile | null;
  validation: {
    isValid: boolean;
    passedCount: number;
    failedCount: number;
    items: DeployValidationItem[];
  };
  activity: DeployActivityItem[];
  deployRun: DeployRunSummary;
  health: DeployHealthSummary;
  healthHistory: DeployHealthHistoryItem[];
};

type DeployDashboardResponse = {
  summary: DashboardSummary;
  clients: DeployClientCard[];
};

type BootstrapPayload = {
  name: string;
  slug: string;
  domain: string;
  brandName: string;
  primaryColor: string;
  tariff: string;
  industryTemplate: string;
  includedUsers: number;
  maxAdmins: number;
  aiRequestsLimit: number;
  adminLogin: string;
  adminEmail: string;
  adminPhone: string;
  adminFirstName: string;
  adminLastName: string;
  adminPassword: string;
  systemAdminLogin: string;
  systemAdminPassword: string;
  hostUrl: string;
  deployPath: string;
  lmsSourcePath: string;
  databaseHost: string;
  databasePort: number;
  databaseName: string;
  databaseUser: string;
  databasePasswordSecretRef: string;
  storageBucket: string;
  storageRegion: string;
  storageEndpoint: string;
  storageSecretRef: string;
  aiProvider: string;
  aiModel: string;
  aiSecretRef: string;
  aliceTenantCode: string;
  aliceModelPreset: string;
  previewThemePrimary: string;
  previewThemeAccent: string;
  previewThemeBackground: string;
  previewThemeSurface: string;
};

type UpdateProfilePayload = {
  clientId: string;
  brandName: string;
  clientAdminLogin: string;
  clientAdminPassword: string;
  systemAdminLogin: string;
  systemAdminPassword: string;
  primaryColor: string;
  tariff: string;
  industryTemplate: string;
  includedUsers: number;
  maxAdmins: number;
  aiRequestsLimit: number;
  hostUrl: string;
  deployPath: string;
  lmsSourcePath: string;
  databaseHost: string;
  databasePort: number;
  databaseName: string;
  databaseUser: string;
  databasePasswordSecretRef: string;
  storageBucket: string;
  storageRegion: string;
  storageEndpoint: string;
  storageSecretRef: string;
  aiProvider: string;
  aiModel: string;
  aiSecretRef: string;
  aliceTenantCode: string;
  aliceModelPreset: string;
  previewThemePrimary: string;
  previewThemeAccent: string;
  previewThemeBackground: string;
  previewThemeSurface: string;
  status: string;
};

type DeployRunResponse = {
  message?: string | string[];
  status?: string;
  deploymentBundlePath?: string;
  steps?: Array<{
    code: string;
    label: string;
    note: string;
  }>;
};

type HealthCheckRunResponse = {
  message?: string | string[];
  overallStatus?: "healthy" | "degraded" | "down";
  healthyCount?: number;
  degradedCount?: number;
  downCount?: number;
  unknownCount?: number;
};

const deployStatusOptions = [
  { value: "draft", label: "Черновик" },
  { value: "validated", label: "Проверено" },
  { value: "ready_to_deploy", label: "Готово к деплою" },
  { value: "deployed", label: "Развернуто" }
];

const tariffOptions = [
  {
    value: "base",
    label: "Базовый",
    includedUsers: 5,
    maxAdmins: 1,
    aiRequestsLimit: 0
  },
  {
    value: "extended",
    label: "Расширенный",
    includedUsers: 50,
    maxAdmins: 3,
    aiRequestsLimit: 500
  },
  {
    value: "corporate",
    label: "Корпоративный",
    includedUsers: 500,
    maxAdmins: 10,
    aiRequestsLimit: 5000
  }
];

const industryOptions = INDUSTRY_TEMPLATE_OPTIONS.map((item) => ({
  value: item.code,
  label: item.label,
  shortLabel: item.shortLabel
}));

const initialCreateForm: BootstrapPayload = {
  name: "",
  slug: "",
  domain: "",
  brandName: "",
  primaryColor: "#0abab5",
  tariff: "base",
  industryTemplate: DEFAULT_INDUSTRY_TEMPLATE,
  includedUsers: 5,
  maxAdmins: 1,
  aiRequestsLimit: 0,
  adminLogin: "",
  adminEmail: "",
  adminPhone: "",
  adminFirstName: "",
  adminLastName: "",
  adminPassword: "",
  systemAdminLogin: "",
  systemAdminPassword: "",
  hostUrl: "",
  deployPath: "",
  lmsSourcePath: "",
  databaseHost: "",
  databasePort: 5432,
  databaseName: "",
  databaseUser: "",
  databasePasswordSecretRef: "",
  storageBucket: "",
  storageRegion: "",
  storageEndpoint: "",
  storageSecretRef: "",
  aiProvider: "alice-ai",
  aiModel: "alice-core",
  aiSecretRef: "",
  aliceTenantCode: "",
  aliceModelPreset: "alice-default",
  previewThemePrimary: "#0abab5",
  previewThemeAccent: "#6ee7d8",
  previewThemeBackground: "#071419",
  previewThemeSurface: "#0f2229"
};

function toUpdateProfileForm(detail: DeployClientDetail | null): UpdateProfilePayload | null {
  if (!detail?.profile) {
    return null;
  }

  return {
    clientId: detail.profile.clientId,
    brandName: detail.client.brandName,
    clientAdminLogin: detail.adminCredentials.clientAdminLogin ?? detail.client.firstAdminEmail ?? "",
    clientAdminPassword: "",
    systemAdminLogin: detail.adminCredentials.systemAdminLogin ?? "",
    systemAdminPassword: "",
    primaryColor: detail.client.features.branding ? detail.profile.previewThemePrimary ?? "#0abab5" : detail.profile.previewThemePrimary ?? "#0abab5",
    tariff: detail.client.tariff,
    industryTemplate: detail.client.industryTemplate ?? DEFAULT_INDUSTRY_TEMPLATE,
    includedUsers: detail.client.features.includedUsers,
    maxAdmins: detail.client.features.maxAdmins,
    aiRequestsLimit: detail.client.aiRequestsLimit ?? 0,
    hostUrl: detail.profile.hostUrl,
    deployPath: detail.profile.deployPath ?? "",
    lmsSourcePath: detail.profile.lmsSourcePath ?? "",
    databaseHost: detail.profile.databaseHost,
    databasePort: detail.profile.databasePort,
    databaseName: detail.profile.databaseName,
    databaseUser: detail.profile.databaseUser,
    databasePasswordSecretRef: detail.profile.databasePasswordSecretRef ?? "",
    storageBucket: detail.profile.storageBucket,
    storageRegion: detail.profile.storageRegion ?? "",
    storageEndpoint: detail.profile.storageEndpoint ?? "",
    storageSecretRef: detail.profile.storageSecretRef ?? "",
    aiProvider: detail.profile.aiProvider,
    aiModel: detail.profile.aiModel,
    aiSecretRef: detail.profile.aiSecretRef ?? "",
    aliceTenantCode: detail.profile.aliceTenantCode ?? "",
    aliceModelPreset: detail.profile.aliceModelPreset ?? "",
    previewThemePrimary: detail.profile.previewThemePrimary ?? "#0abab5",
    previewThemeAccent: detail.profile.previewThemeAccent ?? "#6ee7d8",
    previewThemeBackground: detail.profile.previewThemeBackground ?? "#071419",
    previewThemeSurface: detail.profile.previewThemeSurface ?? "#0f2229",
    status: detail.profile.status
  };
}

function toEditorForm(detail: DeployClientDetail | null): BootstrapPayload {
  if (!detail?.profile) {
    return initialCreateForm;
  }

  return {
    name: detail.client.name,
    slug: detail.client.domain.split(".")[0] ?? detail.client.name.toLowerCase().replace(/\s+/g, "-"),
    domain: detail.client.domain,
    brandName: detail.client.brandName,
    primaryColor: detail.profile.previewThemePrimary ?? "#0abab5",
    tariff: detail.client.tariff,
    industryTemplate: detail.client.industryTemplate ?? DEFAULT_INDUSTRY_TEMPLATE,
    includedUsers: detail.client.features.includedUsers,
    maxAdmins: detail.client.features.maxAdmins,
    aiRequestsLimit: detail.client.aiRequestsLimit ?? 0,
    adminLogin: detail.adminCredentials.clientAdminLogin ?? detail.client.firstAdminEmail ?? "",
    adminEmail: detail.adminCredentials.clientAdminLogin ?? detail.client.firstAdminEmail ?? "",
    adminPhone: detail.adminCredentials.clientAdminPhone ?? "",
    adminFirstName: detail.adminCredentials.clientAdminFirstName ?? "",
    adminLastName: detail.adminCredentials.clientAdminLastName ?? "",
    adminPassword: "",
    systemAdminLogin: detail.adminCredentials.systemAdminLogin ?? "",
    systemAdminPassword: "",
    hostUrl: detail.profile.hostUrl,
    deployPath: detail.profile.deployPath ?? "",
    lmsSourcePath: detail.profile.lmsSourcePath ?? "",
    databaseHost: detail.profile.databaseHost,
    databasePort: detail.profile.databasePort,
    databaseName: detail.profile.databaseName,
    databaseUser: detail.profile.databaseUser,
    databasePasswordSecretRef: detail.profile.databasePasswordSecretRef ?? "",
    storageBucket: detail.profile.storageBucket,
    storageRegion: detail.profile.storageRegion ?? "",
    storageEndpoint: detail.profile.storageEndpoint ?? "",
    storageSecretRef: detail.profile.storageSecretRef ?? "",
    aiProvider: detail.profile.aiProvider,
    aiModel: detail.profile.aiModel,
    aiSecretRef: detail.profile.aiSecretRef ?? "",
    aliceTenantCode: detail.profile.aliceTenantCode ?? "",
    aliceModelPreset: detail.profile.aliceModelPreset ?? "alice-default",
    previewThemePrimary: detail.profile.previewThemePrimary ?? "#0abab5",
    previewThemeAccent: detail.profile.previewThemeAccent ?? "#6ee7d8",
    previewThemeBackground: detail.profile.previewThemeBackground ?? "#071419",
    previewThemeSurface: detail.profile.previewThemeSurface ?? "#0f2229"
  };
}

function formatActivityTime(value: string): string {
  const date = new Date(value);

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function formatOptionalActivityTime(value: string | null): string {
  return value ? formatActivityTime(value) : "еще не запускался";
}

function getStatusLabel(status: string): string {
  return deployStatusOptions.find((item) => item.value === status)?.label ?? status;
}

function getHealthLabel(status: "healthy" | "degraded" | "down" | "unknown"): string {
  if (status === "healthy") {
    return "Здоров";
  }

  if (status === "degraded") {
    return "Частично";
  }

  if (status === "unknown") {
    return "Не проверено";
  }

  return "Проблема";
}

function getHealthBadgeClass(status: "healthy" | "degraded" | "down" | "unknown"): string {
  return status === "healthy" ? "badge-ok" : "badge-pending";
}

function getOperatorNextStep(detail: DeployClientDetail | null, currentStatus: string): string {
  if (!detail) {
    return "Создай первого клиента и заполни стартовый профиль деплоя.";
  }

  if (!detail.profile) {
    return "Заполни технический профиль деплоя для клиента.";
  }

  if (!detail.validation.isValid) {
    return "Исправь ошибки проверки и запусти проверку перед деплоем.";
  }

  if (currentStatus === "draft") {
    return "Нажми «Отметить как проверено», чтобы перевести клиента дальше.";
  }

  if (currentStatus === "validated") {
    return "Подготовь профиль к созданию локального пакета клиента.";
  }

  if (currentStatus === "ready_to_deploy") {
    return "Подготовь локальный пакет. Загрузка на удалённый сервер пока не подключена.";
  }

  if (currentStatus === "deployed") {
    return "Этот статус сохранён ранее. Доступность удалённого сайта нужно проверить отдельно.";
  }

  return "Проверь карточку клиента и технический профиль.";
}

function LockedHostField({
  label,
  placeholder,
  value = ""
}: {
  label: string;
  placeholder: string;
  value?: string;
}) {
  return (
    <label className="locked-field">
      <span>{label}</span>
      <div className="locked-input-wrap">
        <input value={value} placeholder={placeholder} readOnly disabled />
        <strong>недоступно</strong>
      </div>
    </label>
  );
}

function getTariffLabel(code: string): string {
  return tariffOptions.find((item) => item.value === code)?.label ?? code;
}

function getIndustryLabel(code: string): string {
  return getIndustryTemplateShortLabel(code);
}

function getIndustryRoles(code: string): readonly string[] {
  return (
    INDUSTRY_TEMPLATE_OPTIONS.find((item) => item.code === code)?.roles ?? []
  );
}

function getTariffPreset(code: string): {
  includedUsers: number;
  maxAdmins: number;
  aiRequestsLimit: number;
} {
  const preset = tariffOptions.find((item) => item.value === code) ?? tariffOptions[0];

  return {
    includedUsers: preset.includedUsers,
    maxAdmins: preset.maxAdmins,
    aiRequestsLimit: preset.aiRequestsLimit
  };
}

function getTariffFeatureMatrix(code: string): Array<{ label: string; enabled: boolean }> {
  const preset = tariffOptions.find((item) => item.value === code)?.value ?? "base";

  if (preset === "corporate") {
    return [
      { label: "AI модуль", enabled: true },
      { label: "Расширенная аналитика", enabled: true },
      { label: "API export", enabled: true },
      { label: "Мультиточечность", enabled: true }
    ];
  }

  if (preset === "extended") {
    return [
      { label: "AI модуль", enabled: true },
      { label: "Расширенная аналитика", enabled: true },
      { label: "API export", enabled: false },
      { label: "Мультиточечность", enabled: false }
    ];
  }

  return [
    { label: "AI модуль", enabled: false },
    { label: "Расширенная аналитика", enabled: false },
    { label: "API export", enabled: false },
    { label: "Мультиточечность", enabled: false }
  ];
}

function describeTariffTransition(currentTariff: string, nextTariff: string): {
  currentLabel: string;
  nextLabel: string;
  enabled: string[];
  disabled: string[];
} {
  const currentMatrix = getTariffFeatureMatrix(currentTariff);
  const nextMatrix = getTariffFeatureMatrix(nextTariff);
  const enabled = nextMatrix
    .filter((item) => item.enabled && !currentMatrix.find((currentItem) => currentItem.label === item.label)?.enabled)
    .map((item) => item.label);
  const disabled = currentMatrix
    .filter((item) => item.enabled && !nextMatrix.find((nextItem) => nextItem.label === item.label)?.enabled)
    .map((item) => item.label);

  return {
    currentLabel: getTariffLabel(currentTariff),
    nextLabel: getTariffLabel(nextTariff),
    enabled,
    disabled
  };
}

export function DeployPanelClient({
  dashboard: incomingDashboard,
  detail: incomingDetail,
  selectedClientId,
  loadError
}: {
  dashboard: DeployDashboardResponse;
  detail: DeployClientDetail | null;
  selectedClientId: string | null;
  loadError?: string | null;
}): React.ReactElement {
  const router = useRouter();
  const [panelReady, setPanelReady] = useState(false);
  const lastGoodDataRef = useRef({ dashboard: incomingDashboard, detail: incomingDetail });
  const dashboard = loadError ? lastGoodDataRef.current.dashboard : incomingDashboard;
  const detail = loadError ? lastGoodDataRef.current.detail : incomingDetail;
  const [isReloadTransition, startReloadTransition] = useTransition();
  useEffect(() => {
    if (!loadError) lastGoodDataRef.current = { dashboard: incomingDashboard, detail: incomingDetail };
  }, [incomingDashboard, incomingDetail, loadError]);
  const [isCreateTransition, startCreateTransition] = useTransition();
  const [isUpdateTransition, startUpdateTransition] = useTransition();
  const [createForm, setCreateForm] = useState<BootstrapPayload>(initialCreateForm);
  const [createConnection, setCreateConnection] = useState(emptyConnectionAccess);
  const [accessState, setAccessState] = useState({ dirty: false, busy: false });
  const [accessCaptureWarning, setAccessCaptureWarning] = useState("");
  const [profileForm, setProfileForm] = useState<UpdateProfilePayload | null>(toUpdateProfileForm(detail));
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [updateSuccess, setUpdateSuccess] = useState("");
  const [isValidateTransition, startValidateTransition] = useTransition();
  const [validationError, setValidationError] = useState("");
  const [validationSuccess, setValidationSuccess] = useState("");
  const [isDeployTransition, startDeployRunTransition] = useTransition();
  const [deployRunError, setDeployRunError] = useState("");
  const [deployRunSuccess, setDeployRunSuccess] = useState("");
  const [isHealthTransition, startHealthRunTransition] = useTransition();
  const [healthRunError, setHealthRunError] = useState("");
  const [healthRunSuccess, setHealthRunSuccess] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("list");
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const deferredClientSearch = useDeferredValue(clientSearch);
  const visibleClients = filterClients(dashboard.clients, deferredClientSearch);
  const [pendingAction, setPendingAction] = useState<PanelAction | null>(null);
  const [profileBaseline, setProfileBaseline] = useState(() => JSON.stringify(toUpdateProfileForm(detail)));
  const operationGateRef = useRef(new PanelOperationGate());
  const mountedRef = useRef(false);
  const currentClientRef = useRef(detail?.client.id ?? null);
  const previousClientRef = useRef(detail?.client.id ?? null);
  const profileFormRef = useRef(profileForm);
  const createFormRef = useRef(createForm);
  const createConnectionRef = useRef(createConnection);
  const profileBaselineRef = useRef(profileBaseline);
  currentClientRef.current = detail?.client.id ?? null;
  profileFormRef.current = profileForm;
  createFormRef.current = createForm;
  createConnectionRef.current = createConnection;
  profileBaselineRef.current = profileBaseline;
  const isCreating = pendingAction === "create" || isCreateTransition;
  const isUpdating = pendingAction === "profile" || pendingAction === "workflow" || isUpdateTransition;
  const isValidating = pendingAction === "validate" || isValidateTransition;
  const isDeployRunning = pendingAction === "package" || isDeployTransition;
  const isHealthRunning = pendingAction === "health" || isHealthTransition;
  const isBusy = accessState.busy || Boolean(loadError) || isReloadTransition || pendingAction !== null || isCreateTransition || isUpdateTransition || isValidateTransition || isDeployTransition || isHealthTransition;
  const hasProfileDraft = JSON.stringify(profileForm) !== profileBaseline;
  const hasCreateDraft = JSON.stringify(createForm) !== JSON.stringify(initialCreateForm) || JSON.stringify(createConnection) !== JSON.stringify(emptyConnectionAccess);

  useEffect(() => {
    mountedRef.current = true;
    setPanelReady(true);
    return () => { mountedRef.current = false; operationGateRef.current.cancel(); };
  }, []);

  useEffect(() => {
    if (loadError) return;
    const nextId = detail?.client.id ?? null;
    const nextProfile = toUpdateProfileForm(detail);
    const changedClient = previousClientRef.current !== nextId;
    const dirty = JSON.stringify(profileFormRef.current) !== profileBaselineRef.current;
    if (changedClient) {
      operationGateRef.current.cancel();
      setPendingAction(null);
      setUpdateError(""); setUpdateSuccess("");
      setValidationError(""); setValidationSuccess("");
      setDeployRunError(""); setDeployRunSuccess("");
      setHealthRunError(""); setHealthRunSuccess("");
      setWorkspaceMode((current) => current === "list" ? "list" : detail ? "client" : "list");
      setProfileEditorOpen(false);
    }
    // A status refresh must not replace newer typing in the same client's form.
    if (changedClient || !dirty) setProfileForm(nextProfile);
    setProfileBaseline(JSON.stringify(nextProfile));
    previousClientRef.current = nextId;
  }, [detail, loadError]);

  useEffect(() => {
    if (!hasProfileDraft && !hasCreateDraft && !accessState.dirty && !pendingAction) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasProfileDraft, hasCreateDraft, accessState.dirty, pendingAction]);

  function operationIsCurrent(operation: PanelOperation): boolean {
    return mountedRef.current && operationGateRef.current.isCurrent(operation, currentClientRef.current);
  }

  async function runPanelAction(action: PanelAction, perform: (operation: PanelOperation) => Promise<void>): Promise<void> {
    if (loadError || isReloadTransition || isCreateTransition || isUpdateTransition || isValidateTransition || isDeployTransition || isHealthTransition) return;
    const operation = operationGateRef.current.begin(action, currentClientRef.current);
    if (!operation) return;
    setPendingAction(action);
    try {
      await perform(operation);
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      const message = panelRequestFailure(error, action !== "validate");
      if (action === "create") setCreateError(message);
      else if (action === "profile" || action === "workflow") setUpdateError(message);
      else if (action === "validate") setValidationError(message);
      else if (action === "package") setDeployRunError(message);
      else setHealthRunError(message);
    } finally {
      if (operationGateRef.current.finish(operation) && mountedRef.current) setPendingAction(null);
    }
  }

  const currentStatus = profileForm?.status ?? detail?.client.deployStatus ?? "draft";
  const canMoveToValidated = Boolean(detail?.validation.isValid && currentStatus === "draft");
  const canMoveToReadyToDeploy = Boolean(detail?.validation.isValid && currentStatus === "validated");
  const canMoveBackToDraft = currentStatus !== "draft";
  const canRunDeploy = currentStatus === "ready_to_deploy";
  const liveSiteUrl = detail?.profile ? buildLiveSiteUrl(detail.profile) : null;
  const tariffTransition =
    detail && profileForm && profileForm.tariff !== detail.client.tariff
      ? describeTariffTransition(detail.client.tariff, profileForm.tariff)
      : null;
  const operatorNextStep = getOperatorNextStep(detail, currentStatus);

  function applyCreateTariff(tariff: string): void {
    const preset = getTariffPreset(tariff);

    setCreateForm({
      ...createForm,
      tariff,
      includedUsers: preset.includedUsers,
      maxAdmins: preset.maxAdmins,
      aiRequestsLimit: preset.aiRequestsLimit
    });
  }

  function applyProfileTariff(tariff: string): void {
    if (!profileForm) {
      return;
    }

    const preset = getTariffPreset(tariff);

    setProfileForm({
      ...profileForm,
      tariff,
      includedUsers: preset.includedUsers,
      maxAdmins: preset.maxAdmins,
      aiRequestsLimit: preset.aiRequestsLimit
    });
  }

  function openClient(clientId: string): void {
    if (clientId === currentClientRef.current) { setWorkspaceMode("client"); setClientPickerOpen(false); setClientSearch(""); return; }
    if (pendingAction && !window.confirm("Операция еще выполняется. Перейти к другому клиенту? Ожидание будет остановлено, но сервер мог уже принять команду. Проверь результат перед повтором.")) return;
    if (clientId !== currentClientRef.current && (hasProfileDraft || accessState.dirty) && !window.confirm("Перейти к другому клиенту? Несохраненные правки текущей карточки будут потеряны.")) return;
    setClientPickerOpen(false);
    setClientSearch("");
    operationGateRef.current.cancel();
    setPendingAction(null);
    setWorkspaceMode("client");
    router.replace(`/?clientId=${clientId}`);
    router.refresh();
  }

  function resetEditorToCreateMode(): void {
    setWorkspaceMode("create");
  }

  function clearCreateDraft(): void {
    if (isBusy || !window.confirm("Очистить мастер? Введенные данные нового клиента будут удалены только из формы.")) return;
    setCreateForm(initialCreateForm);
    setCreateConnection(emptyConnectionAccess);
    setCreateError(""); setCreateSuccess("");
  }

  function discardProfileDraft(): void {
    if (pendingAction || isUpdateTransition || !hasProfileDraft || !window.confirm("Отменить несохраненные правки этой карточки? Это очистит только введенные поля, а не откатит данные на сервере.")) return;
    try {
      const restored = JSON.parse(profileBaseline) as UpdateProfilePayload | null;
      if (!restored || restored.clientId !== currentClientRef.current) throw new Error("Profile baseline mismatch");
      setProfileForm(restored);
      setUpdateError("");
      setUpdateSuccess("Несохраненные правки отменены. Данные на сервере не изменялись.");
    } catch {
      setUpdateError("Не удалось восстановить сохраненные поля. Обновите данные карточки и проверьте ее перед продолжением.");
    }
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await runPanelAction("create", async (operation) => {
      const submitted = fillClientAddresses(createForm);
      const connection = { ...createConnection };
      const submittedFingerprint = JSON.stringify(createForm);
      setCreateError("");
      setCreateSuccess("");
      if (![submitted.adminLogin || submitted.adminEmail, submitted.systemAdminLogin].every(value => /^[a-z0-9][a-z0-9_.@+-]{0,119}$/i.test(value)) || (submitted.adminLogin || submitted.adminEmail).toLowerCase() === submitted.systemAdminLogin.toLowerCase()) throw Error("Укажите разные логины администраторов без пробелов.");
      if ([submitted.adminPassword, submitted.systemAdminPassword].some(value => value.length < 12 || value.length > 128)) throw Error("Пароли администраторов: от 12 до 128 символов.");

      const response = await requestPanel("/api/bootstrap-client", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...submitted,
          adminLogin: createForm.adminLogin || createForm.adminEmail || undefined,
          primaryColor: createForm.primaryColor || undefined,
          industryTemplate: createForm.industryTemplate || undefined,
          aiRequestsLimit: createForm.aiRequestsLimit || undefined,
          adminPhone: createForm.adminPhone || undefined,
          adminLastName: createForm.adminLastName || undefined,
          deployPath: createForm.deployPath || undefined,
          lmsSourcePath: createForm.lmsSourcePath || undefined,
          databasePasswordSecretRef: createForm.databasePasswordSecretRef || undefined,
          storageRegion: createForm.storageRegion || undefined,
          storageEndpoint: createForm.storageEndpoint || undefined,
          storageSecretRef: createForm.storageSecretRef || undefined,
          aiSecretRef: createForm.aiSecretRef || undefined,
          aliceTenantCode: createForm.aliceTenantCode || undefined,
          aliceModelPreset: createForm.aliceModelPreset || undefined,
          previewThemePrimary: createForm.previewThemePrimary || undefined,
          previewThemeAccent: createForm.previewThemeAccent || undefined,
          previewThemeBackground: createForm.previewThemeBackground || undefined,
          previewThemeSurface: createForm.previewThemeSurface || undefined
        })
      }, operation.controller.signal);

      const payload = (await response.json()) as {
        message?: string | string[];
        clientId?: string;
      };
      if (!operationIsCurrent(operation)) return;

      if (!response.ok) {
        setCreateError(
          Array.isArray(payload.message)
            ? payload.message.join(", ")
            : payload.message ?? "Не удалось создать клиента"
        );
        return;
      }

      if (typeof payload.clientId !== "string" || !payload.clientId) throw new Error("Missing created client identity");
      try {
        await installationAccessRequest("capture", payload.clientId, { ...connection,
          host: extractClientIp(submitted.hostUrl) || extractClientIp(submitted.domain) || new URL(submitted.hostUrl).hostname,
          databaseHost: connection.databaseHost || submitted.databaseHost,
          clientAdminName: submitted.adminFirstName, clientAdminLogin: submitted.adminLogin || submitted.adminEmail,
          clientAdminPassword: submitted.adminPassword, systemAdminLogin: submitted.systemAdminLogin, systemAdminPassword: submitted.systemAdminPassword }, 0);
        setAccessCaptureWarning("");
      } catch (failure) { setAccessCaptureWarning(`Клиент уже создан, повторять создание не нужно. Пароли для установки не сохранены: ${failure instanceof Error ? failure.message : "ошибка хранилища"}. Откройте «Пароли и доступы» в его карточке.`); }
      if (!operationIsCurrent(operation)) return;
      const hasNewerInput = JSON.stringify(createFormRef.current) !== submittedFingerprint || JSON.stringify(createConnectionRef.current) !== JSON.stringify(connection);
      setCreateSuccess(hasNewerInput ? "Клиент создан. Более новый ввод остался в мастере; созданный клиент доступен в списке." : "Клиент создан. Открываю его карточку.");
      if (!hasNewerInput) {
        setCreateForm(initialCreateForm);
        setCreateConnection(emptyConnectionAccess);
        setWorkspaceMode("client");
      } else {
        setCreateForm((current) => ({
          ...current,
          adminPassword: current.adminPassword === submitted.adminPassword ? "" : current.adminPassword,
          systemAdminPassword: current.systemAdminPassword === submitted.systemAdminPassword ? "" : current.systemAdminPassword
        }));
      }
      startCreateTransition(() => {
        if (!hasNewerInput) {
          router.replace(`/?clientId=${encodeURIComponent(payload.clientId as string)}`);
        }
        router.refresh();
      });
    });
  }

  async function submitProfile(): Promise<void> {
    if (!profileForm) {
      return;
    }
    await runPanelAction("profile", async (operation) => {
      const submitted = profileForm;

      setUpdateError("");
      setUpdateSuccess("");

      const response = await requestPanel("/api/update-deploy-profile", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...fillClientAddresses(profileForm),
          industryTemplate: profileForm.industryTemplate || undefined,
          clientAdminLogin: profileForm.clientAdminLogin || undefined,
          clientAdminPassword: profileForm.clientAdminPassword || undefined,
          systemAdminLogin: profileForm.systemAdminLogin || undefined,
          systemAdminPassword: profileForm.systemAdminPassword || undefined,
          primaryColor: profileForm.primaryColor || undefined,
          deployPath: profileForm.deployPath || undefined,
          lmsSourcePath: profileForm.lmsSourcePath || undefined,
          databasePasswordSecretRef: profileForm.databasePasswordSecretRef || undefined,
          storageRegion: profileForm.storageRegion || undefined,
          storageEndpoint: profileForm.storageEndpoint || undefined,
          storageSecretRef: profileForm.storageSecretRef || undefined,
          aiSecretRef: profileForm.aiSecretRef || undefined,
          aliceTenantCode: profileForm.aliceTenantCode || undefined,
          aliceModelPreset: profileForm.aliceModelPreset || undefined,
          previewThemePrimary: profileForm.previewThemePrimary || undefined,
          previewThemeAccent: profileForm.previewThemeAccent || undefined,
          previewThemeBackground: profileForm.previewThemeBackground || undefined,
          previewThemeSurface: profileForm.previewThemeSurface || undefined
        })
      }, operation.controller.signal);

      const payload = (await response.json()) as {
        message?: string | string[];
        status?: string;
      };
      if (!operationIsCurrent(operation)) return;

      if (!response.ok) {
        setUpdateError(
          Array.isArray(payload.message)
            ? payload.message.join(", ")
            : payload.message ?? "Не удалось обновить профиль"
        );
        return;
      }

      const statusLabel = getStatusLabel(payload.status ?? profileForm.status);

      setUpdateSuccess(`Профиль сохранен. Новый статус: ${statusLabel}`);
      const savedStatus = payload.status ?? submitted.status;
      setProfileBaseline(JSON.stringify({ ...submitted, clientAdminPassword: "", systemAdminPassword: "", status: savedStatus }));
      setProfileForm((current) => current?.clientId === submitted.clientId ? {
        ...current,
        clientAdminPassword: current.clientAdminPassword === submitted.clientAdminPassword ? "" : current.clientAdminPassword,
        systemAdminPassword: current.systemAdminPassword === submitted.systemAdminPassword ? "" : current.systemAdminPassword,
        status: savedStatus
      } : current);
      startUpdateTransition(() => {
        if (profileForm.clientId) {
          router.replace(`/?clientId=${profileForm.clientId}`);
        }
        router.refresh();
      });
    });
  }

  async function handleUpdateSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await submitProfile();
  }

  async function handleWorkflowTransition(nextStatus: string): Promise<void> {
    if (!detail?.client.id || !profileForm) {
      return;
    }
    await runPanelAction("workflow", async (operation) => {

      setUpdateError("");
      setUpdateSuccess("");

      const endpointMap: Record<string, string> = {
        draft: "/api/mark-draft",
        validated: "/api/mark-validated",
        ready_to_deploy: "/api/mark-ready-to-deploy",
        deployed: "/api/mark-deployed"
      };

      const endpoint = endpointMap[nextStatus];
      if (!endpoint) throw new Error("Unknown workflow action");
      const response = await requestPanel(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: detail.client.id
        })
      }, operation.controller.signal);

      const payload = (await response.json()) as {
        message?: string | string[];
        status?: string;
      };
      if (!operationIsCurrent(operation)) return;

      if (!response.ok) {
        setUpdateError(
          Array.isArray(payload.message)
            ? payload.message.join(", ")
            : payload.message ?? "Не удалось выполнить workflow-действие"
        );
        return;
      }

      const nextStatusCode = payload.status ?? nextStatus;
      setUpdateSuccess(`Этап изменен: ${getStatusLabel(nextStatusCode)}`);
      setProfileForm((current) => current?.clientId === detail.client.id ? { ...current, status: nextStatusCode } : current);
      setProfileBaseline((current) => { const baseline = JSON.parse(current) as UpdateProfilePayload | null; return JSON.stringify(baseline ? { ...baseline, status: nextStatusCode } : baseline); });

      startUpdateTransition(() => {
        router.replace(`/?clientId=${detail.client.id}`);
        router.refresh();
      });
    });
  }

  async function handleValidateClient(): Promise<void> {
    if (!detail?.client.id || !profileForm) {
      return;
    }
    await runPanelAction("validate", async (operation) => {

      setValidationError("");
      setValidationSuccess("");

      const response = await requestPanel(`/api/validate-client?clientId=${encodeURIComponent(detail.client.id)}`, {
        method: "GET",
        cache: "no-store"
      }, operation.controller.signal, 30000);

      const payload = (await response.json()) as {
        message?: string | string[];
        isValid?: boolean;
        recommendedStatus?: string;
        passedCount?: number;
        failedCount?: number;
      };
      if (!operationIsCurrent(operation)) return;

      if (!response.ok) {
        setValidationError(
          Array.isArray(payload.message)
            ? payload.message.join(", ")
            : payload.message ?? "Не удалось запустить проверку"
        );
        return;
      }

      if (payload.isValid) {
        setValidationSuccess(
          `Проверка пройдена: ${payload.passedCount} из ${payload.passedCount}. Теперь можно нажать "Отметить как проверено".`
        );
      } else {
        setValidationError(
          `Проверка не пройдена: ошибок ${payload.failedCount}. Сначала исправь поля ниже в блоке проверки и профиле деплоя.`
        );
      }

      startValidateTransition(() => {
        router.replace(`/?clientId=${detail.client.id}`);
        router.refresh();
      });
    });
  }

  async function handleDeployRun(): Promise<void> {
    if (!detail?.client.id || !profileForm) {
      return;
    }
    await runPanelAction("package", async (operation) => {

      setDeployRunError("");
      setDeployRunSuccess("");

      const response = await requestPanel("/api/run-deploy", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: detail.client.id
        })
      }, operation.controller.signal, 120000);

      const payload = (await response.json()) as DeployRunResponse;
      if (!operationIsCurrent(operation)) return;

      if (!response.ok) {
        setDeployRunError(
          Array.isArray(payload.message)
            ? payload.message.join(", ")
            : payload.message ?? "Не удалось подготовить локальный пакет"
        );
        return;
      }

      const stepSummary = payload.steps?.map((item) => item.label).join(" -> ");
      setDeployRunSuccess(
        `Локальный пакет подготовлен. Удаленный сервер не изменялся.${stepSummary ? ` Шаги: ${stepSummary}.` : ""}${payload.deploymentBundlePath ? ` Папка: ${payload.deploymentBundlePath}` : ""}`
      );
      const savedStatus = payload.status ?? "ready_to_deploy";
      setProfileForm((current) => current?.clientId === detail.client.id ? { ...current, status: savedStatus } : current);
      setProfileBaseline((current) => { const baseline = JSON.parse(current) as UpdateProfilePayload | null; return JSON.stringify(baseline ? { ...baseline, status: savedStatus } : baseline); });

      startDeployRunTransition(() => {
        router.replace(`/?clientId=${detail.client.id}`);
        router.refresh();
      });
    });
  }

  async function handleHealthRun(): Promise<void> {
    if (!detail?.client.id) {
      return;
    }
    await runPanelAction("health", async (operation) => {

      setHealthRunError("");
      setHealthRunSuccess("");

      const response = await requestPanel("/api/run-health-check", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientId: detail.client.id
        })
      }, operation.controller.signal, 45000);

      const payload = (await response.json()) as HealthCheckRunResponse;
      if (!operationIsCurrent(operation)) return;

      if (!response.ok) {
        setHealthRunError(
          Array.isArray(payload.message)
            ? payload.message.join(", ")
            : payload.message ?? "Не удалось запустить health-check"
        );
        return;
      }

      setHealthRunSuccess(
        `Проверка завершена. Норма: ${payload.healthyCount ?? 0}, частично: ${payload.degradedCount ?? 0}, проблемы: ${payload.downCount ?? 0}, не проверено: ${payload.unknownCount ?? 0}.`
      );

      startHealthRunTransition(() => {
        router.replace(`/?clientId=${detail.client.id}`);
        router.refresh();
      });
    });
  }

  return (
    <main className="page-shell" data-panel-ready={String(panelReady)} data-workspace-mode={workspaceMode}>
      <CoreClientSelection id={detail?.client.id ?? null} name={detail?.client.name ?? ""} blocked={Boolean(loadError)} dirty={hasProfileDraft || hasCreateDraft || accessState.dirty} busy={isBusy || !panelReady} />
      {accessCaptureWarning ? <p className="message-error" role="alert">{accessCaptureWarning}</p> : null}
      <section className="hero-panel compact-hero">
        <div className="hero-kicker core-optional-hint">LMS Core · Панель клиентов</div>
        <h1>
          {workspaceMode === "list"
            ? "Клиенты"
            : workspaceMode === "create"
            ? "Новый клиент"
            : workspaceMode === "client"
              ? detail?.client.name ?? "Карточка клиента"
              : "Мониторинг клиента"}
        </h1>
        <p className="core-optional-hint">
          {workspaceMode === "create"
            ? "Отдельный пошаговый сценарий для создания нового клиента и первичного deploy-профиля."
            : workspaceMode === "client"
              ? "Отдельная зона для просмотра клиента, редактирования технического профиля и ссылок на LMS."
              : "Проверка готовности, локального пакета и журнала действий клиента."}
        </p>
      </section>

      {pendingAction ? <div className="panel-operation-state" role="status" aria-live="polite">{({ create: "Создаю клиента...", profile: "Сохраняю поля клиента...", workflow: "Меняю этап подготовки...", validate: "Проверяю сохраненные параметры...", package: "Подготавливаю локальный пакет...", health: "Проверяю состояние клиента..." } as const)[pendingAction]}</div> : null}

      <details className={`summary-details${workspaceMode === "monitoring" ? "" : " workspace-panel-hidden"}`}>
        <summary>Сводка по клиентам</summary>
        <section className="stats-grid stats-grid-wide">
          <article className="stat-card stat-card-centered">
            <span className="stat-label">Всего клиентов</span>
            <strong>{loadError ? "—" : dashboard.summary.totalClients}</strong>
          </article>
          <article className="stat-card stat-card-centered">
            <span className="stat-label">Черновик</span>
            <strong>{loadError ? "—" : dashboard.summary.draftCount}</strong>
          </article>
          <article className="stat-card stat-card-centered">
            <span className="stat-label">Проверено</span>
            <strong>{loadError ? "—" : dashboard.summary.validatedCount}</strong>
          </article>
          <article className="stat-card stat-card-centered">
            <span className="stat-label">Готово к деплою</span>
            <strong>{loadError ? "—" : dashboard.summary.readyToDeployCount}</strong>
          </article>
          <article className="stat-card stat-card-centered">
            <span className="stat-label">Развернуто</span>
            <strong>{loadError ? "—" : dashboard.summary.deployedCount}</strong>
          </article>
        </section>
      </details>

      <section className="operator-strip workspace-tabs">
        {workspaceMode !== "list" ? <button type="button" className="button-secondary client-back-button" onClick={() => setWorkspaceMode("list")}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>К списку клиентов</button> : <span className="client-directory-caption">{dashboard.clients.length} клиентов</span>}
        <div className="client-workspace-actions">
          {workspaceMode === "client" && detail ? <><button type="button" className="button-secondary" onClick={() => { setProfileEditorOpen(true); requestAnimationFrame(() => document.getElementById("client-profile-settings")?.scrollIntoView({ block: "start" })); }}>Редактировать</button><button type="button" className="button-secondary" onClick={() => setWorkspaceMode("monitoring")}>Мониторинг</button></> : null}
          {workspaceMode === "monitoring" && detail ? <button type="button" className="button-secondary" onClick={() => setWorkspaceMode("client")}>Карточка клиента</button> : null}
          {workspaceMode !== "create" ? <button type="button" disabled={isBusy} onClick={resetEditorToCreateMode}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Новый клиент</button> : null}
        </div>
      </section>

      {detail && workspaceMode === "monitoring" ? <section className="operator-cockpit">
        <div className="operator-cockpit-main">
          <span className="stat-label">Текущий клиент</span>
          <strong>{detail?.client.name ?? "Клиент не выбран"}</strong>
          <p>{operatorNextStep}</p>
        </div>

        <div className="operator-cockpit-grid">
          <article>
            <span>Этап</span>
            <strong>{detail ? getStatusLabel(currentStatus) : "Нет данных"}</strong>
          </article>
          <article>
            <span>Готовность</span>
            <strong>{detail ? `${detail.client.readinessPercent}%` : "Нет данных"}</strong>
          </article>
          <article>
            <span>Проверка</span>
            <strong>{detail ? getHealthLabel(detail.health.overallStatus) : "Нет данных"}</strong>
          </article>
          <article>
            <span>Тариф</span>
            <strong>{profileForm?.tariff ? getTariffLabel(profileForm.tariff) : detail ? getTariffLabel(detail.client.tariff) : "Не выбран"}</strong>
          </article>
          <article>
            <span>Отрасль</span>
            <strong>{profileForm?.industryTemplate ? getIndustryLabel(profileForm.industryTemplate) : detail ? getIndustryLabel(detail.client.industryTemplate) : "Не выбрана"}</strong>
          </article>
        </div>
      </section> : null}

      {loadError ? (
        <section className="system-warning-card">
          <strong>Deploy-panel открылась, но backend сейчас не отдал данные.</strong>
          <p>
            Обычно это значит, что не запущен PostgreSQL на `55432` или API на `3001`.
            Запусти PostgreSQL и API в Core, затем повтори загрузку. Последние полученные данные и черновик остаются в панели.
          </p>
          <code>{loadError}</code>
          <button type="button" className="button-secondary" disabled={isReloadTransition} onClick={() => startReloadTransition(() => router.refresh())}>{isReloadTransition ? "Загрузка..." : "Повторить загрузку данных"}</button>
        </section>
      ) : null}

      <section
        id="client-editor"
        className={`surface-card form-card workspace-panel${workspaceMode === "create" ? "" : " workspace-panel-hidden"}`}
      >
        <div className="section-head">
          <div>
            <h2>Данные нового клиента</h2>
            <span className="section-note core-optional-hint">
              Создание клиента, первого админа, системного админа и стартового профиля деплоя
            </span>
          </div>
        </div>

        <form className="deploy-form" onSubmit={handleCreateSubmit}>
          <section className="form-section">
            <div className="form-section-head">
              <h3>Клиент и тариф</h3>
              <p>Данные, которые определяют бренд, отрасль и доступные функции LMS.</p>
            </div>
            <div className="form-grid">
              <label><span>Название клиента</span><input value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} required /></label>
              <label><span>Код клиента (slug)</span><input value={createForm.slug} onChange={(event) => setCreateForm({ ...createForm, slug: event.target.value })} required /></label>
              <label><span>Домен или IP клиента</span><input value={createForm.domain} onChange={(event) => setCreateForm({ ...createForm, domain: event.target.value })} onBlur={() => setCreateForm(current => fillClientAddresses(current))} required /></label>
              <label><span>Название бренда</span><input value={createForm.brandName} onChange={(event) => setCreateForm({ ...createForm, brandName: event.target.value })} required /></label>
              <label><span>Тариф</span><select value={createForm.tariff} onChange={(event) => applyCreateTariff(event.target.value)}>{tariffOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label><span>Отраслевой шаблон</span><select value={createForm.industryTemplate} onChange={(event) => setCreateForm({ ...createForm, industryTemplate: event.target.value })}>{industryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label><span>Лимит пользователей</span><input type="number" min="1" value={createForm.includedUsers} onChange={(event) => setCreateForm({ ...createForm, includedUsers: Number(event.target.value) })} required /></label>
              <label><span>Лимит админов</span><input type="number" min="1" max="10" value={createForm.maxAdmins} onChange={(event) => setCreateForm({ ...createForm, maxAdmins: Number(event.target.value) })} required /></label>
              <label><span>Лимит AI запросов</span><input type="number" min="0" value={createForm.aiRequestsLimit} onChange={(event) => setCreateForm({ ...createForm, aiRequestsLimit: Number(event.target.value) })} /></label>
            </div>
          </section>

          <section className="form-section credentials-card">
            <div className="form-section-head">
              <h3>Пароли и доступы</h3>
              <p>Введите один раз: Core сохранит доступы для этого клиента и использует при установке. Пароли LMS — от 12 символов, логины без пробелов.</p>
            </div>
            <div className="form-grid">
              <label><span>Логин администратора клиента</span><input value={createForm.adminLogin} onChange={(event) => setCreateForm({ ...createForm, adminLogin: event.target.value })} required /></label>
              <label><span>Пароль администратора клиента</span><input type="password" minLength={12} maxLength={128} autoComplete="new-password" value={createForm.adminPassword} onChange={(event) => setCreateForm({ ...createForm, adminPassword: event.target.value })} required /></label>
              <label><span>Email администратора клиента</span><input type="email" value={createForm.adminEmail} onChange={(event) => setCreateForm({ ...createForm, adminEmail: event.target.value })} required /></label>
              <label><span>Телефон</span><input value={createForm.adminPhone} onChange={(event) => setCreateForm({ ...createForm, adminPhone: event.target.value })} /></label>
              <label><span>Имя</span><input value={createForm.adminFirstName} onChange={(event) => setCreateForm({ ...createForm, adminFirstName: event.target.value })} required /></label>
              <label><span>Фамилия</span><input value={createForm.adminLastName} onChange={(event) => setCreateForm({ ...createForm, adminLastName: event.target.value })} /></label>
              <label><span>Логин системного администратора</span><input value={createForm.systemAdminLogin} onChange={(event) => setCreateForm({ ...createForm, systemAdminLogin: event.target.value })} required /></label>
              <label><span>Пароль системного администратора</span><input type="password" minLength={12} maxLength={128} autoComplete="new-password" value={createForm.systemAdminPassword} onChange={(event) => setCreateForm({ ...createForm, systemAdminPassword: event.target.value })} required /></label>
            </div>
            <ConnectionAccessFields value={{ ...createConnection, databaseHost: createConnection.databaseHost || createForm.databaseHost || extractClientIp(createForm.domain) }} onChange={setCreateConnection} />
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <h3>Сервер LMS</h3>
              <p>Где будет жить сайт клиента. В локальной версии SSH-поля заблокированы до production-режима.</p>
            </div>
            <div className="form-grid">
              <label><span>Адрес LMS хоста</span><input value={createForm.hostUrl} onChange={(event) => setCreateForm({ ...createForm, hostUrl: event.target.value })} onBlur={() => setCreateForm(current => fillClientAddresses(current))} required /></label>
              <label><span>Путь деплоя</span><input value={createForm.deployPath} onChange={(event) => setCreateForm({ ...createForm, deployPath: event.target.value })} placeholder="/srv/lms/client-name" /></label>
              <label><span>Папка исходника LMS</span><input value={createForm.lmsSourcePath} onChange={(event) => setCreateForm({ ...createForm, lmsSourcePath: event.target.value })} required /></label>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <h3>Сервер базы данных</h3>
              <p>По умолчанию БД на том же сервере. Для отдельного PostgreSQL задайте другой адрес и административный доступ в блоке паролей.</p>
            </div>
            <div className="form-grid">
              <label><span>Хост базы данных</span><input value={createForm.databaseHost} onChange={(event) => setCreateForm({ ...createForm, databaseHost: event.target.value })} onBlur={() => setCreateForm(current => fillClientAddresses(current))} required /></label>
              <label><span>Порт базы данных</span><input type="number" min="1" max="65535" value={createForm.databasePort} onChange={(event) => setCreateForm({ ...createForm, databasePort: Number(event.target.value) })} required /></label>
              <label><span>Имя базы данных</span><input value={createForm.databaseName} onChange={(event) => setCreateForm({ ...createForm, databaseName: event.target.value })} required /></label>
              <label><span>Пользователь базы</span><input value={createForm.databaseUser} onChange={(event) => setCreateForm({ ...createForm, databaseUser: event.target.value })} required /></label>
              <label><span>Секрет пароля БД</span><input value={createForm.databasePasswordSecretRef} onChange={(event) => setCreateForm({ ...createForm, databasePasswordSecretRef: event.target.value })} placeholder="vault/client/db-password" /></label>
              <LockedHostField label="Адрес SSH сервера БД" placeholder="пока не подключено" />
              <LockedHostField label="Пользователь SSH сервера БД" placeholder="например postgres-admin" />
              <LockedHostField label="Порт SSH сервера БД" placeholder="22" />
              <LockedHostField label="Секрет SSH сервера БД" placeholder="защищённое хранилище" />
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <h3>Storage и AI</h3>
              <p>Файлы клиента и Alice AI. Эти поля нужны для будущего production-развертывания.</p>
            </div>
            <div className="form-grid">
              <label><span>Бакет storage</span><input value={createForm.storageBucket} onChange={(event) => setCreateForm({ ...createForm, storageBucket: event.target.value })} required /></label>
              <label><span>Регион storage</span><input value={createForm.storageRegion} onChange={(event) => setCreateForm({ ...createForm, storageRegion: event.target.value })} /></label>
              <label><span>Endpoint storage</span><input value={createForm.storageEndpoint} onChange={(event) => setCreateForm({ ...createForm, storageEndpoint: event.target.value })} /></label>
              <label><span>Секрет storage</span><input value={createForm.storageSecretRef} onChange={(event) => setCreateForm({ ...createForm, storageSecretRef: event.target.value })} placeholder="vault/client/storage" /></label>
              <label><span>AI провайдер</span><input value={createForm.aiProvider} onChange={(event) => setCreateForm({ ...createForm, aiProvider: event.target.value })} required /></label>
              <label><span>AI модель</span><input value={createForm.aiModel} onChange={(event) => setCreateForm({ ...createForm, aiModel: event.target.value })} required /></label>
              <label><span>AI секрет</span><input value={createForm.aiSecretRef} onChange={(event) => setCreateForm({ ...createForm, aiSecretRef: event.target.value })} placeholder="vault/client/ai-key" /></label>
              <label><span>Код tenant Alice</span><input value={createForm.aliceTenantCode} onChange={(event) => setCreateForm({ ...createForm, aliceTenantCode: event.target.value })} placeholder="client-slug" /></label>
              <label><span>Preset Alice</span><input value={createForm.aliceModelPreset} onChange={(event) => setCreateForm({ ...createForm, aliceModelPreset: event.target.value })} /></label>
            </div>
          </section>

          <div className="form-actions">
            <button type="submit" disabled={isBusy}>{isCreating ? "Создание..." : "Создать клиентский пакет"}</button>
            <button type="button" className="button-secondary" disabled={isBusy || !hasCreateDraft} onClick={clearCreateDraft}>Очистить форму</button>
            {createError ? <p className="message-error">{createError}</p> : null}
            {createSuccess ? <p className="message-success">{createSuccess}</p> : null}
          </div>
        </form>
      </section>

      <section className={`content-grid workspace-panel${workspaceMode === "create" ? " workspace-panel-hidden" : ""}`}>
        <article id="client-list" className={`surface-card${workspaceMode === "list" ? "" : " workspace-panel-hidden"}`}>
          <section id="client-picker" className="client-picker" data-expanded={workspaceMode === "list" || clientPickerOpen || !detail}>
            <button type="button" className="client-picker-summary" aria-expanded={clientPickerOpen || !detail} aria-controls="client-picker-content" onClick={() => setClientPickerOpen((open) => !open)}>
              <span><span className="client-picker-caption">Выбор клиента</span><strong>{detail?.client.name ?? "Выберите клиента"}</strong></span>
              <span className="client-picker-action">Сменить клиента <span className="client-picker-count">{dashboard.clients.length}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></span>
            </button>
            <div id="client-picker-content" hidden={workspaceMode !== "list" && !clientPickerOpen && Boolean(detail)}>
            <div className="client-picker-tools">
              <label><span>Поиск клиента</span><input type="search" value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Имя, бренд или домен" maxLength={200} /></label>
              <span className="client-picker-result" aria-live="polite">Найдено: {visibleClients.length} из {dashboard.clients.length}</span>
              {clientSearch ? <button type="button" className="button-secondary" onClick={() => setClientSearch("")}>Сбросить поиск</button> : null}
            </div>
          <div className="client-list client-picker-list" aria-label="Клиенты" aria-busy={clientSearch !== deferredClientSearch}>
            {visibleClients.map((client) => {
              const isSelected = client.id === selectedClientId;

              return (
                <button
                  key={client.id}
                  data-client-id={client.id}
                  aria-pressed={isSelected}
                  type="button"
                  className={`client-card client-card-button${isSelected ? " client-card-selected" : ""}`}
                  onClick={() => openClient(client.id)}
                >
                  <div className="client-topline">
                    <div>
                      <h3>{client.name}</h3>
                      <p>{client.domain}</p>
                    </div>
                    <span className={client.isActive ? "badge-ok" : "badge-pending"}>
                      {client.isActive ? "Активен" : "Выключен"}
                    </span>
                  </div>

                  <div className="client-meta client-card-primary-meta">
                    <span className="client-card-tariff">Тариф: {getTariffLabel(client.tariff)}</span>
                    <span>Отрасль: {getIndustryLabel(client.industryTemplate)}</span>
                  </div>

                  <div className="status-row">
                    <span className="status-pill">{client.deployStatusLabel}</span>
                    <span className="status-caption">Готовность: {client.readinessPercent}%</span>
                  </div>

                  <div className="progress-row">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${client.readinessPercent}%` }} />
                    </div>
                    <span>{client.readinessPercent}%</span>
                  </div>

                  <div className="client-meta">
                    <span>Готово: {client.readyCount}</span>
                    <span>Ожидает: {client.pendingCount}</span>
                  </div>

                  <div className="client-meta">
                    <span>Админ: {client.firstAdminEmail ?? "не создан"}</span>
                    <span>AI: {client.features.aiAssistant ? "включен" : "выключен"}</span>
                  </div>

                  <div className="client-open-row">
                    <span className="client-open-link">
                      Открыть карточку
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
            {!visibleClients.length ? <p className="empty-copy">{dashboard.clients.length ? "Клиенты не найдены. Измените запрос или сбросьте поиск." : "Клиенты пока не созданы. Начните с мастера создания."}</p> : null}
            </div>
          </section>
        </article>

        <article id="client-card" className={`surface-card${workspaceMode === "list" ? " workspace-panel-hidden" : ""}`}>
          <div className="section-head section-head-centered">
            <div>
              <h2>Карточка клиента</h2>
              <span className="section-note section-note-centered">
                Выбранный клиент и его технический профиль
              </span>
            </div>
          </div>

          {detail ? (
            <>
              <div className="detail-header detail-header-centered">
                <h3 className="client-detail-name">{detail.client.name}</h3>
                <p>{detail.client.domain}</p>
                <div className="status-row status-row-centered">
                  <span className="status-pill">{detail.client.deployStatusLabel}</span>
                </div>
              </div>

              {workspaceMode === "client" ? <dl className="client-brief-summary"><div><dt>Тариф</dt><dd>{getTariffLabel(detail.client.tariff)}</dd></div><div><dt>Отрасль</dt><dd>{getIndustryLabel(detail.client.industryTemplate)}</dd></div><div><dt>Лимит сотрудников</dt><dd>{detail.client.features.includedUsers}</dd></div></dl> : null}
              <div className={workspaceMode === "client" ? "" : "workspace-panel-hidden"}><InstallationAccessCard key={detail.client.id} clientId={detail.client.id} blocked={Boolean(loadError) || hasProfileDraft || Boolean(pendingAction)} onState={setAccessState} onSaved={() => startReloadTransition(() => router.refresh())} /></div>

              {workspaceMode === "client" ? (
                <section className="mode-intro-card core-optional-hint">
                  <strong>Карточка уже созданного клиента</strong>
                  <p>
                    Здесь смотришь сохраненные данные клиента, открываешь LMS и редактируешь
                    технический профиль. Проверки и логи вынесены отдельно в мониторинг.
                  </p>
                </section>
              ) : null}

              {workspaceMode === "monitoring" ? (
                <section className="mode-intro-card core-optional-hint">
                  <strong>Мониторинг и эксплуатация</strong>
                  <p>
                    Здесь проверяется готовность клиента, состояние API/БД/storage/AI,
                    запуск deploy-run и последние события из журнала.
                  </p>
                </section>
              ) : null}

              <div className={`workflow-actions client-only${workspaceMode === "client" ? "" : " workspace-panel-hidden"}`}>
                <span className="status-caption core-optional-hint">Просмотр и редактор доступны в отдельном разделе «LMS» Core.</span>
                {liveSiteUrl ? (
                  <a className="button-link button-link-muted" href={liveSiteUrl} target="_blank" rel="noreferrer">
                    Сайт на хосте
                  </a>
                ) : null}
              </div>

              <details className={`advanced-section client-only${workspaceMode === "client" ? "" : " workspace-panel-hidden"}`}>
                <summary>Сохраненные данные клиента</summary>
                <section className="validation-card">
                  <div className="section-head section-head-centered">
                    <div>
                      <h2>Что сохранено по клиенту</h2>
                      <span className="section-note section-note-centered">
                        Ключевые данные, которые должны уходить в локальное LMS-превью
                      </span>
                    </div>
                  </div>

                  <ul className="checklist">
                    <li className="checklist-item">
                      <span className="badge-ok">Бренд</span>
                      <div>
                        <strong>{detail.client.brandName}</strong>
                        <p>Тариф: {getTariffLabel(detail.client.tariff)} • Отрасль: {getIndustryLabel(detail.client.industryTemplate)}</p>
                      </div>
                    </li>
                    <li className="checklist-item">
                      <span className="badge-ok">Стартовые роли</span>
                      <div>
                        <strong>{getIndustryRoles(detail.client.industryTemplate).join(" • ")}</strong>
                        <p>Это базовый набор ролей для выбранного отраслевого шаблона</p>
                      </div>
                    </li>
                    <li className="checklist-item">
                      <span className="badge-ok">Лимиты</span>
                      <div>
                        <strong>Пользователи: {detail.client.features.includedUsers}</strong>
                        <p>Админы: {detail.client.features.maxAdmins}, AI: {detail.client.aiRequestsLimit ?? 0}</p>
                      </div>
                    </li>
                    <li className="checklist-item">
                      <span className="badge-ok">Админ клиента</span>
                      <div>
                        <strong>{detail.adminCredentials.clientAdminLogin ?? detail.client.firstAdminEmail ?? "не создан"}</strong>
                        <p>Логин администратора клиента</p>
                      </div>
                    </li>
                    <li className="checklist-item">
                      <span className="badge-ok">Системный админ</span>
                      <div>
                        <strong>{detail.adminCredentials.systemAdminLogin ?? "не создан"}</strong>
                        <p>Логин системного администратора платформы</p>
                      </div>
                    </li>
                    <li className="checklist-item">
                      <span className="badge-pending">Git-LMS</span>
                      <div>
                        <strong>Просмотр запускается отдельно в Core</strong>
                        <p>Выбранный commit и реальная готовность показаны во вкладке «LMS из Git». Наличие карточки не означает запущенный сайт.</p>
                      </div>
                    </li>
                  </ul>
                </section>
              </details>

              <details className={`advanced-section client-only${workspaceMode === "client" ? "" : " workspace-panel-hidden"}`}>
                <summary>Доступы администраторов</summary>
                <section className="validation-card">
                  <div className="section-head section-head-centered">
                    <div>
                      <h2>Доступы</h2>
                      <span className="section-note section-note-centered">
                        Быстрый просмотр логинов администраторов без открытия длинной формы
                      </span>
                    </div>
                  </div>

                  <ul className="checklist">
                    <li className="checklist-item">
                      <span className="badge-ok">Админ клиента</span>
                      <div>
                        <strong>{detail.adminCredentials.clientAdminLogin ?? "не задан"}</strong>
                        <p>Email: {detail.client.firstAdminEmail ?? "не задан"}</p>
                      </div>
                    </li>
                    <li className="checklist-item">
                      <span className="badge-ok">Системный админ</span>
                      <div>
                        <strong>{detail.adminCredentials.systemAdminLogin ?? "не задан"}</strong>
                        <p>Пароль намеренно не показывается в интерфейсе</p>
                      </div>
                    </li>
                  </ul>
                </section>
              </details>

              <details className={`advanced-section client-only${workspaceMode === "client" ? "" : " workspace-panel-hidden"}`}>
                <summary>Проверка технического профиля</summary>
                <ul className="checklist">
                  {detail.checklist.map((item) => (
                    <li key={item.code} className="checklist-item">
                      <span className={item.status === "ready" ? "badge-ok" : "badge-pending"}>
                        {item.status === "ready" ? "Готово" : "Нужно"}
                      </span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.note}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>

              <section id="client-validation" className={`validation-card monitoring-only${workspaceMode === "monitoring" ? "" : " workspace-panel-hidden"}`}>
                <div className="section-head section-head-centered">
                  <div>
                    <h2>Проверка перед деплоем</h2>
                    <span className="section-note section-note-centered">
                      Панель проверяет, достаточно ли данных для перехода в статус "Проверено"
                    </span>
                  </div>
                </div>

                <div className="validation-summary">
                  <span className={detail.validation.isValid ? "badge-ok" : "badge-pending"}>
                    {detail.validation.isValid ? "Проверка пройдена" : "Есть ошибки"}
                  </span>
                  <span className="status-caption">
                    Пройдено: {detail.validation.passedCount} • Ошибок: {detail.validation.failedCount}
                  </span>
                </div>

                <ul className="checklist">
                  {detail.validation.items.map((item) => (
                    <li key={item.code} className="checklist-item">
                      <span className={item.status === "passed" ? "badge-ok" : "badge-pending"}>
                        {item.status === "passed" ? "OK" : "Ошибка"}
                      </span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.note}</p>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="form-actions validation-actions">
                  <button type="button" disabled={isBusy} onClick={() => void handleValidateClient()}>
                    {isValidating ? "Проверка..." : "Запустить проверку"}
                  </button>
                  {validationError ? <p className="message-error">{validationError}</p> : null}
                  {validationSuccess ? <p className="message-success">{validationSuccess}</p> : null}
                </div>
              </section>

              <details id="client-preview" className={`advanced-section client-only${workspaceMode === "client" ? "" : " workspace-panel-hidden"}`}>
                <summary>Локальные ссылки LMS</summary>
                <section className="validation-card preview-card">
                  <div className="section-head section-head-centered">
                    <div>
                      <h2>Источник и адрес установки</h2>
                      <span className="section-note section-note-centered">
                        Git-версия выбирается в Core. Адрес хоста не является подтверждением работающей установки.
                      </span>
                    </div>
                  </div>

                  <div className="deploy-run-summary">
                    <span className="status-pill">Тариф: {profileForm?.tariff ? getTariffLabel(profileForm.tariff) : getTariffLabel(detail.client.tariff)}</span>
                    <span className="status-caption">Отрасль: {getIndustryLabel(profileForm?.industryTemplate ?? detail.client.industryTemplate)}</span>
                    <span className="status-caption">
                      Сборка: {detail.profile?.deploymentBundlePath ?? "еще не собрана"}
                    </span>
                  </div>

                  <div className="client-meta">
                    <span>Источник LMS: {detail.profile?.lmsSourcePath ?? "не задан"}</span>
                    <span>
                      Alice AI: {detail.profile?.aliceTenantCode ?? "не задан"} / {detail.profile?.aliceModelPreset ?? "не задан"}
                    </span>
                  </div>

                  <div className="preview-link-grid">
                    {liveSiteUrl ? (
                      <a className="button-link button-link-muted" href={liveSiteUrl} target="_blank" rel="noreferrer">
                        Открыть адрес хоста
                      </a>
                    ) : detail.profile?.hostUrl ? (
                      <div className="preview-link-hint">
                        В профиле указан неполный адрес хоста, поэтому внешнюю ссылку пока не открываю.
                      </div>
                    ) : null}
                  </div>

                </section>
              </details>

              <details id="client-health" className={`advanced-section monitoring-only${workspaceMode === "monitoring" ? "" : " workspace-panel-hidden"}`}>
                <summary>Проверка сервисов клиента</summary>
                <section className="validation-card">
                  <div className="section-head section-head-centered">
                    <div>
                      <h2>Проверка сервисов клиента</h2>
                      <span className="section-note section-note-centered">
                        Доступность Core отдельно от непроверенных сервисов клиента
                      </span>
                    </div>
                  </div>

                  <div className="deploy-run-summary">
                    <span className={getHealthBadgeClass(detail.health.overallStatus)}>
                      Общий статус: {getHealthLabel(detail.health.overallStatus)}
                    </span>
                    <span className="status-caption">
                      Норма: {detail.health.healthyCount} • Частично: {detail.health.degradedCount} • Проблемы: {detail.health.downCount} • Не проверено: {detail.health.unknownCount}
                    </span>
                  </div>

                  <div className="form-actions validation-actions">
                    <button type="button" className="button-secondary" disabled={isBusy} onClick={() => void handleHealthRun()}>
                      {isHealthRunning ? "Проверка сервисов..." : "Повторить проверку сервисов"}
                    </button>
                    {healthRunError ? <p className="message-error">{healthRunError}</p> : null}
                    {healthRunSuccess ? <p className="message-success">{healthRunSuccess}</p> : null}
                  </div>

                  <ul className="checklist">
                    {detail.health.items.map((item) => (
                      <li key={item.code} className="checklist-item">
                        <span className={getHealthBadgeClass(item.status)}>{getHealthLabel(item.status)}</span>
                        <div>
                          <strong>{item.label}</strong>
                          <p>{item.note}</p>
                        </div>
                      </li>
                    ))}
                  </ul>

                  <div className="health-history">
                    <h3>История health-check</h3>
                    {detail.healthHistory.length > 0 ? (
                      <div className="activity-list">
                        {detail.healthHistory.map((item) => (
                          <article key={item.id} className="activity-card">
                            <div className="activity-topline">
                              <strong>{getHealthLabel(item.overallStatus)}</strong>
                              <span className="activity-time">{formatActivityTime(item.createdAt)}</span>
                            </div>
                            <p className="activity-note">{item.note}</p>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="empty-copy">Проверка сервисов еще не запускалась вручную.</p>
                    )}
                  </div>
                </section>
              </details>

              <details className={`advanced-section monitoring-only${workspaceMode === "monitoring" ? "" : " workspace-panel-hidden"}`}>
                <summary>Отчет подготовки локального пакета</summary>
                <section className="validation-card">
                  <div className="section-head section-head-centered">
                    <div>
                      <h2>Отчет подготовки локального пакета</h2>
                      <span className="section-note section-note-centered">
                        Подготовка файлов на этом компьютере не загружает их на сервер
                      </span>
                    </div>
                  </div>

                  {detail.deployRun.hasRun ? (
                    <>
                      <div className="deploy-run-summary">
                        <span className="status-pill">
                          Итог: {getStatusLabel(detail.deployRun.status ?? "deployed")}
                        </span>
                        <span className="status-caption">
                          Последний запуск: {formatOptionalActivityTime(detail.deployRun.lastRunAt)}
                        </span>
                        <span className="status-caption">
                          Шагов: {detail.deployRun.stepCount}
                        </span>
                      </div>

                      <ul className="checklist">
                        {detail.deployRun.steps.map((step) => (
                          <li key={step.code} className="checklist-item">
                            <span className="badge-ok">Шаг</span>
                            <div>
                              <strong>{step.label}</strong>
                              <p>{step.note}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="empty-copy">Локальный пакет для этого клиента еще не создавался.</p>
                  )}
                </section>
              </details>

              <details className={`advanced-section monitoring-only${workspaceMode === "monitoring" ? "" : " workspace-panel-hidden"}`}>
                <summary>Журнал действий</summary>
                <section className="validation-card">
                  <div className="section-head section-head-centered">
                    <div>
                      <h2>Журнал действий</h2>
                      <span className="section-note section-note-centered">
                        Последние события по клиенту из audit log
                      </span>
                    </div>
                  </div>

                  <div className="activity-list">
                    {detail.activity.length > 0 ? (
                      detail.activity.map((item) => (
                        <article key={item.id} className="activity-card">
                          <div className="activity-topline">
                            <strong>{item.title}</strong>
                            <span className="activity-time">{formatActivityTime(item.createdAt)}</span>
                          </div>
                          <p className="activity-note">{item.note}</p>
                          <span className="activity-code">{item.action}</span>
                        </article>
                      ))
                    ) : (
                      <p className="empty-copy">Для этого клиента пока нет deploy-событий.</p>
                    )}
                  </div>
                </section>
              </details>

              {profileForm ? (
                <details id="client-profile-settings" className={`client-profile-disclosure${workspaceMode === "client" ? "" : " workspace-panel-hidden"}`} open={profileEditorOpen} onToggle={(event) => setProfileEditorOpen(event.currentTarget.open)}>
                <summary>Настройки клиента</summary>
                <form id="deploy-profile-editor" className={`deploy-form profile-form client-only${workspaceMode === "client" ? "" : " workspace-panel-hidden"}`} onSubmit={handleUpdateSubmit}>
                  <div className="form-divider">Редактирование профиля деплоя</div>
                  <p className="flow-hint">
                    Установка из Git запускается в разделе «Репозиторий» Core. Подготовка локального пакета здесь не устанавливает сайт на сервер.
                  </p>
                  <div className="workflow-summary">
                    <span className="status-pill">Текущий этап: {getStatusLabel(currentStatus)}</span>
                    {hasProfileDraft ? <span className="draft-note" role="status">Есть несохраненные поля. Проверки используют сохраненную версию.</span> : null}
                  </div>
                  <div className="workflow-actions">
                    <button type="button" className="button-secondary" disabled={isBusy} onClick={() => void submitProfile()}>
                      {isUpdating ? "Сохранение..." : "Сохранить поля"}
                    </button>
                    <button type="button" className="button-secondary" disabled={Boolean(pendingAction) || isUpdateTransition || !hasProfileDraft} onClick={discardProfileDraft}>Отменить правки</button>
                    <button type="button" className="button-secondary" disabled={isBusy || !canMoveBackToDraft} onClick={() => void handleWorkflowTransition("draft")}>
                      Вернуть в черновик
                    </button>
                    <button type="button" disabled={isBusy || !canMoveToValidated} onClick={() => void handleWorkflowTransition("validated")}>
                      Отметить как проверено
                    </button>
                    <button type="button" disabled={isBusy || !canMoveToReadyToDeploy} onClick={() => void handleWorkflowTransition("ready_to_deploy")}>
                      Подготовить к деплою
                    </button>
                    <button type="button" className="button-run" disabled={isBusy || !canRunDeploy} onClick={() => void handleDeployRun()}>
                      {isDeployRunning ? "Подготавливается пакет..." : "Подготовить локальный пакет"}
                    </button>
                  </div>
                  {deployRunError ? <p className="message-error">{deployRunError}</p> : null}
                  {deployRunSuccess ? <p className="message-success">{deployRunSuccess}</p> : null}

                  {tariffTransition ? (
                    <section className="tariff-transition-card">
                      <strong>
                        Переход тарифа: {tariffTransition.currentLabel} {"->"} {tariffTransition.nextLabel}
                      </strong>
                      <div className="tariff-transition-grid">
                        <div>
                          <span className="status-caption">Включится после пересохранения</span>
                          {tariffTransition.enabled.length > 0 ? (
                            <ul className="tariff-transition-list">
                              {tariffTransition.enabled.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="empty-copy">Новых функций не добавится.</p>
                          )}
                        </div>
                        <div>
                          <span className="status-caption">Отключится после пересохранения</span>
                          {tariffTransition.disabled.length > 0 ? (
                            <ul className="tariff-transition-list">
                              {tariffTransition.disabled.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="empty-copy">Функции не будут отключены.</p>
                          )}
                        </div>
                      </div>
                    </section>
                  ) : null}

                  <section className="form-section">
                    <div className="form-section-head">
                      <h3>Основные данные</h3>
                      <p>Редактирование бренда, тарифа, отрасли и лимитов клиента.</p>
                    </div>
                    <div className="form-grid">
                      <label><span>Название бренда</span><input value={profileForm.brandName} onChange={(event) => setProfileForm({ ...profileForm, brandName: event.target.value })} required /></label>
                      <label><span>Тариф</span><select value={profileForm.tariff} onChange={(event) => applyProfileTariff(event.target.value)}>{tariffOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                      <label><span>Отраслевой шаблон</span><select value={profileForm.industryTemplate} onChange={(event) => setProfileForm({ ...profileForm, industryTemplate: event.target.value })}>{industryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                      <label><span>Лимит пользователей</span><input type="number" min="1" value={profileForm.includedUsers} onChange={(event) => setProfileForm({ ...profileForm, includedUsers: Number(event.target.value) })} required /></label>
                      <label><span>Лимит админов</span><input type="number" min="1" value={profileForm.maxAdmins} onChange={(event) => setProfileForm({ ...profileForm, maxAdmins: Number(event.target.value) })} required /></label>
                      <label><span>Лимит AI запросов</span><input type="number" min="0" value={profileForm.aiRequestsLimit} onChange={(event) => setProfileForm({ ...profileForm, aiRequestsLimit: Number(event.target.value) })} /></label>
                    </div>
                  </section>

                  <section className="form-section">
                    <div className="form-section-head">
                      <h3>Сервер LMS</h3>
                      <p>Адрес сайта клиента и будущие параметры удаленного доступа.</p>
                    </div>
                    <div className="form-grid">
                      <label><span>Адрес LMS хоста</span><input value={profileForm.hostUrl} onChange={(event) => setProfileForm({ ...profileForm, hostUrl: event.target.value })} onBlur={() => setProfileForm(current => current ? fillClientAddresses(current) : current)} required /></label>
                      <label><span>Путь деплоя</span><input value={profileForm.deployPath} onChange={(event) => setProfileForm({ ...profileForm, deployPath: event.target.value })} /></label>
                      <label><span>Папка исходника LMS</span><input value={profileForm.lmsSourcePath} onChange={(event) => setProfileForm({ ...profileForm, lmsSourcePath: event.target.value })} required /></label>
                    </div>
                  </section>

                  <section className="form-section">
                    <div className="form-section-head">
                      <h3>Сервер базы данных</h3>
                      <p>Отдельная база клиента и будущие параметры удаленного доступа к DB-серверу.</p>
                    </div>
                    <div className="form-grid">
                      <label><span>Хост базы данных</span><input value={profileForm.databaseHost} onChange={(event) => setProfileForm({ ...profileForm, databaseHost: event.target.value })} onBlur={() => setProfileForm(current => current ? fillClientAddresses(current) : current)} required /></label>
                      <label><span>Порт базы данных</span><input type="number" min="1" max="65535" value={profileForm.databasePort} onChange={(event) => setProfileForm({ ...profileForm, databasePort: Number(event.target.value) })} required /></label>
                      <label><span>Имя базы данных</span><input value={profileForm.databaseName} onChange={(event) => setProfileForm({ ...profileForm, databaseName: event.target.value })} required /></label>
                      <label><span>Пользователь базы</span><input value={profileForm.databaseUser} onChange={(event) => setProfileForm({ ...profileForm, databaseUser: event.target.value })} required /></label>
                      <label><span>Секрет пароля БД</span><input value={profileForm.databasePasswordSecretRef} onChange={(event) => setProfileForm({ ...profileForm, databasePasswordSecretRef: event.target.value })} /></label>
                      <LockedHostField label="Адрес SSH сервера БД" placeholder="пока не подключено" />
                      <LockedHostField label="Пользователь SSH сервера БД" placeholder="например postgres-admin" />
                      <LockedHostField label="Порт SSH сервера БД" placeholder="22" />
                      <LockedHostField label="Секрет SSH сервера БД" placeholder="защищённое хранилище" />
                    </div>
                  </section>

                  <section className="form-section">
                    <div className="form-section-head">
                      <h3>Storage и AI</h3>
                      <p>Файлы клиента, Alice AI и служебные secret references.</p>
                    </div>
                    <div className="form-grid">
                      <label><span>Бакет storage</span><input value={profileForm.storageBucket} onChange={(event) => setProfileForm({ ...profileForm, storageBucket: event.target.value })} required /></label>
                      <label><span>Регион storage</span><input value={profileForm.storageRegion} onChange={(event) => setProfileForm({ ...profileForm, storageRegion: event.target.value })} /></label>
                      <label><span>Endpoint storage</span><input value={profileForm.storageEndpoint} onChange={(event) => setProfileForm({ ...profileForm, storageEndpoint: event.target.value })} /></label>
                      <label><span>Секрет storage</span><input value={profileForm.storageSecretRef} onChange={(event) => setProfileForm({ ...profileForm, storageSecretRef: event.target.value })} /></label>
                      <label><span>AI провайдер</span><input value={profileForm.aiProvider} onChange={(event) => setProfileForm({ ...profileForm, aiProvider: event.target.value })} required /></label>
                      <label><span>AI модель</span><input value={profileForm.aiModel} onChange={(event) => setProfileForm({ ...profileForm, aiModel: event.target.value })} required /></label>
                      <label><span>AI секрет</span><input value={profileForm.aiSecretRef} onChange={(event) => setProfileForm({ ...profileForm, aiSecretRef: event.target.value })} /></label>
                      <label><span>Код tenant Alice</span><input value={profileForm.aliceTenantCode} onChange={(event) => setProfileForm({ ...profileForm, aliceTenantCode: event.target.value })} /></label>
                      <label><span>Preset Alice</span><input value={profileForm.aliceModelPreset} onChange={(event) => setProfileForm({ ...profileForm, aliceModelPreset: event.target.value })} /></label>
                      <label><span>Путь deploy bundle</span><input value={detail.profile?.deploymentBundlePath ?? ""} readOnly /></label>
                    </div>
                  </section>

                  <div className="form-actions">
                    <button type="submit" disabled={isBusy}>{isUpdating ? "Обновление..." : "Пересохранить данные"}</button>
                    {updateError ? <p className="message-error">{updateError}</p> : null}
                    {updateSuccess ? <p className="message-success">{updateSuccess}</p> : null}
                  </div>
                </form>
                </details>
              ) : null}
            </>
          ) : (
            <p className="empty-copy">
              {dashboard.clients.length > 0
                ? "Выбери клиента из списка слева, чтобы открыть карточку."
                : "Пока нет клиентов. Сначала создай первую клиентскую карточку."}
            </p>
          )}
        </article>
      </section>
    </main>
  );
}
