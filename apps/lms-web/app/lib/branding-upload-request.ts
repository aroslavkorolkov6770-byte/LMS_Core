export function trustedBrandingUpload(headers: Headers): boolean {
  try {
    const origin = new URL(headers.get("origin") || "");
    // Next's internal request URL can say localhost even when the browser used 127.0.0.1.
    // Match the actual Host, and keep this development upload strictly on loopback.
    return ["http:", "https:"].includes(origin.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) && !origin.username && !origin.password && origin.host === headers.get("host") && headers.get("sec-fetch-site") !== "cross-site";
  } catch { return false; }
}
