export const DEFAULT_LOCAL_PREVIEW_ORIGIN = "http://127.0.0.1:3100";

// This address belongs to the local Core editor, never a deployed client's URL.
export function resolveLocalPreviewOrigin(value: unknown): string {
  try {
    if (typeof value !== "string") return DEFAULT_LOCAL_PREVIEW_ORIGIN;
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
        !url.port || Number(url.port) < 1024 || Number(url.port) > 65535 || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return DEFAULT_LOCAL_PREVIEW_ORIGIN;
    return url.origin;
  } catch {
    return DEFAULT_LOCAL_PREVIEW_ORIGIN;
  }
}
