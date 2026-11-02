export function buildLiveSiteUrl(profile: { hostUrl?: string | null } | null | undefined): string | null {
  if (!profile?.hostUrl) return null;
  try {
    const url = new URL(profile.hostUrl.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    // A server's filesystem directory is not a URL path. Preserve only the explicit website address.
    return url.href;
  } catch {
    return null;
  }
}
