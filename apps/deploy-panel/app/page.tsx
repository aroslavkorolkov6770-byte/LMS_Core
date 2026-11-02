import type { ReactElement } from "react";

import { DeployPanelClient } from "./deploy-panel-client";
import { requestPanelBackend } from "./panel-backend";

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

const emptyDashboard: DeployDashboardResponse = {
  summary: {
    totalClients: 0,
    activeClients: 0,
    draftCount: 0,
    validatedCount: 0,
    readyToDeployCount: 0,
    deployedCount: 0
  },
  clients: []
};

async function fetchDeployPanel<T>(path: string): Promise<T> {
  const response = await requestPanelBackend(path);

  if (!response.ok) {
    throw new Error(`Deploy panel request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function getDeployPanelData(selectedClientId?: string): Promise<{
  dashboard: DeployDashboardResponse;
  detail: DeployClientDetail | null;
  selectedClientId: string | null;
  loadError: string | null;
}> {
  try {
    const dashboard = await fetchDeployPanel<DeployDashboardResponse>("/api/deploy-panel/dashboard");
    if (!dashboard?.summary || !Array.isArray(dashboard.clients) ||
      ![dashboard.summary.totalClients, dashboard.summary.activeClients, dashboard.summary.draftCount, dashboard.summary.validatedCount, dashboard.summary.readyToDeployCount, dashboard.summary.deployedCount].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) ||
      !dashboard.clients.every((client) => client && typeof client.id === "string" && typeof client.name === "string" && client.features)) {
      throw new Error("Invalid dashboard response");
    }
    const activeClient = selectedClientId
      ? dashboard.clients.find((client) => client.id === selectedClientId) ?? null
      : null;
    const detail = activeClient
      ? await fetchDeployPanel<DeployClientDetail>(`/api/deploy-panel/client-detail?clientId=${encodeURIComponent(activeClient.id)}`)
      : null;
    if (activeClient && (!detail || detail.client?.id !== activeClient.id || !detail.adminCredentials ||
      !Array.isArray(detail.checklist) || !Array.isArray(detail.activity) || !Array.isArray(detail.validation?.items) || !Array.isArray(detail.health?.items) ||
      !Array.isArray(detail.healthHistory) || !Array.isArray(detail.deployRun?.steps))) {
      throw new Error("Invalid client detail response");
    }

    return {
      dashboard,
      detail,
      selectedClientId: activeClient?.id ?? null,
      loadError: null
    };
  } catch (error) {
    const message = "Не удалось получить актуальные данные API. Ранее загруженная карточка не заменяется пустой.";

    return {
      dashboard: emptyDashboard,
      detail: null,
      selectedClientId: null,
      loadError: message
    };
  }
}

export default async function Page({
  searchParams
}: {
  searchParams?: Promise<{ clientId?: string }>;
}): Promise<ReactElement> {
  const resolvedSearchParams = await searchParams;
  const { dashboard, detail, selectedClientId, loadError } = await getDeployPanelData(
    resolvedSearchParams?.clientId
  );

  return (
    <DeployPanelClient
      dashboard={dashboard}
      detail={detail}
      selectedClientId={selectedClientId}
      loadError={loadError}
    />
  );
}
