import type { ClientPreviewSettings } from "@lms-core/shared";

export type ClientSiteDesign = {
  clientId: string;
  brandName: string;
  tariff: string;
  industryTemplate: string;
  settings: ClientPreviewSettings;
};

/** Only short routing context belongs in the URL; saved text and design travel as public props/messages. */
export function buildClientSiteFrameUrl(design: Omit<ClientSiteDesign, "settings">, href = "/"): string {
  if (!href.startsWith("/") || href.startsWith("//")) throw new Error("Expected a local LMS path");
  const url = new URL(href, "http://127.0.0.1");
  for (const key of [...url.searchParams.keys()]) if (key.startsWith("preview")) url.searchParams.delete(key);
  url.searchParams.set("previewClientId", design.clientId);
  url.searchParams.set("previewTariff", design.tariff);
  url.searchParams.set("previewIndustryTemplate", design.industryTemplate);
  // Preserve the existing local-preview role behavior, but never connect editor controls in this view.
  url.searchParams.set("previewEditable", "1");
  url.searchParams.set("previewReadonly", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}
