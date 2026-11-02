export function extractClientIp(value: string): string {
  try {
    const raw = value.trim();
    const match = /^(?:https?:\/\/)?((?:\d{1,3}\.){3}\d{1,3})\/?$/i.exec(raw);
    if (!match || match[1].split(".").some(part => part.length > 1 && part.startsWith("0"))) return "";
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return "";
    const parts = url.hostname.split(".");
    return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) ? url.hostname : "";
  } catch { return ""; }
}

export function fillClientAddresses<T extends { domain?: string; hostUrl: string; databaseHost: string }>(value: T): T {
  const ip = [value.hostUrl, value.domain || "", value.databaseHost].map(extractClientIp).find(Boolean);
  if (!ip) return value;
  return { ...value, ...("domain" in value && !value.domain?.trim() ? { domain: ip } : {}), hostUrl: value.hostUrl.trim() || `http://${ip}`, databaseHost: value.databaseHost.trim() || ip };
}
