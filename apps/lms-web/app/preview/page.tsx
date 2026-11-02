import type { ReactElement } from "react";
import { type ClientPreviewSettings } from "@lms-core/shared";

import { PreviewShell } from "./preview-shell";
import { PreviewUnavailable } from "../components/PreviewUnavailable";
import { CoreCleanPreviewState } from "../components/CoreCleanPreviewState";
import { previewBackendFailure, requestPreviewBackend } from "../lib/preview-backend";
import { PreviewRequestError } from "../lib/preview-request";

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
  isActive: boolean;
  firstAdminEmail: string | null;
  readinessPercent: number;
  readyCount: number;
  pendingCount: number;
  deployStatus: string | null;
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
  aiSecretRef: string | null;
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

type PreviewSettingsResponse = {
  clientId: string;
  settings: ClientPreviewSettings;
  source: "saved" | "default";
};

async function fetchClientDetail(clientId: string): Promise<DeployClientDetail> {
  const { payload } = await requestPreviewBackend<DeployClientDetail>(`/api/deploy-panel/client-detail?clientId=${encodeURIComponent(clientId)}`);
  if (!payload?.client || payload.client.id !== clientId) throw new PreviewRequestError("invalid-response");
  return payload;
}

async function fetchPreviewSettings(clientId: string): Promise<PreviewSettingsResponse> {
  const { payload } = await requestPreviewBackend<PreviewSettingsResponse>(`/api/deploy-panel/preview-settings?clientId=${encodeURIComponent(clientId)}`);
  if (payload?.clientId !== clientId || !payload.settings || typeof payload.settings !== "object") throw new PreviewRequestError("invalid-response");
  return payload;
}

export default async function Page({
  searchParams
}: {
  searchParams?: Promise<{
    clientId?: string;
    previewBrandName?: string;
    previewTariff?: string;
    previewIndustryTemplate?: string;
    previewPrimary?: string;
    previewAccent?: string;
    previewBackground?: string;
    previewSurface?: string;
    previewButton?: string;
  }>;
}): Promise<ReactElement> {
  const resolvedSearchParams = await searchParams;
  const clientId = resolvedSearchParams?.clientId;

  if (!clientId) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "linear-gradient(135deg, #061015 0%, #0f2229 100%)",
          color: "#f4f7f6",
          padding: 24
        }}
      >
        <CoreCleanPreviewState clientId={null} />
        <div style={{ maxWidth: 640, textAlign: "center" }}>
          <h1 style={{ margin: "0 0 12px", fontSize: "clamp(28px, 5vw, 52px)" }}>
            Превью не запущено
          </h1>
          <p style={{ margin: 0, color: "rgba(244, 247, 246, 0.72)", lineHeight: 1.6 }}>
            Выберите клиента кнопкой «Выбрать клиента» в Core, чтобы открыть его редактор.
          </p>
        </div>
      </main>
    );
  }

  let detail: DeployClientDetail;
  let previewSettings: PreviewSettingsResponse;
  try {
    [detail, previewSettings] = await Promise.all([fetchClientDetail(clientId), fetchPreviewSettings(clientId)]);
  } catch (error) {
    return <PreviewUnavailable message={previewBackendFailure(error).message} retryHref={`/preview?clientId=${encodeURIComponent(clientId)}`} clientId={clientId} />;
  }

  return (
    <PreviewShell
      key={detail.client.id}
      detail={detail}
      initialSettings={previewSettings.settings}
      overrides={{
        brandName: resolvedSearchParams?.previewBrandName,
        tariff: resolvedSearchParams?.previewTariff,
        industryTemplate: resolvedSearchParams?.previewIndustryTemplate,
        primary: resolvedSearchParams?.previewPrimary,
        accent: resolvedSearchParams?.previewAccent,
        background: resolvedSearchParams?.previewBackground,
        surface: resolvedSearchParams?.previewSurface,
        button: resolvedSearchParams?.previewButton
      }}
    />
  );
}
