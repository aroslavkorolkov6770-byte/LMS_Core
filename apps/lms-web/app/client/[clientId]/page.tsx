import { type ClientPreviewSettings } from "@lms-core/shared";
import { PreviewUnavailable } from "../../components/PreviewUnavailable";
import { previewBackendFailure, requestPreviewBackend } from "../../lib/preview-backend";
import { PreviewRequestError } from "../../lib/preview-request";
import { ClientSiteView } from "./client-site-view";

type DeployClientDetail = {
  client: { id: string; brandName: string; tariff: string; industryTemplate: string };
};

type PreviewSettingsResponse = { clientId: string; settings: ClientPreviewSettings };

export default async function Page({ params }: { params: Promise<{ clientId: string }> }): Promise<React.ReactElement> {
  const { clientId } = await params;
  try {
    const [detailResponse, settingsResponse] = await Promise.all([
      requestPreviewBackend<DeployClientDetail>(`/api/deploy-panel/client-detail?clientId=${encodeURIComponent(clientId)}`),
      requestPreviewBackend<PreviewSettingsResponse>(`/api/deploy-panel/preview-settings?clientId=${encodeURIComponent(clientId)}`)
    ]);
    const detail = detailResponse.payload;
    const preview = settingsResponse.payload;
    if (detail?.client?.id !== clientId || preview?.clientId !== clientId || !preview.settings || typeof preview.settings !== "object") throw new PreviewRequestError("invalid-response");
    return <ClientSiteView key={clientId} design={{ clientId, brandName: detail.client.brandName, tariff: detail.client.tariff, industryTemplate: detail.client.industryTemplate, settings: preview.settings }} />;
  } catch (error) {
    return <PreviewUnavailable message={previewBackendFailure(error).message} retryHref={`/client/${encodeURIComponent(clientId)}`} />;
  }
}
