import { InstallationAccess } from "./client-installation-access";

export function accessProfilePayload(clientId: string, profile: Record<string, any>, value: InstallationAccess) {
  // Whitelist only DTO fields; SQL ids/timestamps/runtime receipts must not be sent back as editable data.
  const keys = ["primaryColor", "tariff", "industryTemplate", "includedUsers", "maxAdmins", "aiRequestsLimit", "hostUrl", "deployPath", "lmsSourcePath", "databaseHost", "databasePort", "databaseName", "databaseUser", "databasePasswordSecretRef", "storageBucket", "storageRegion", "storageEndpoint", "storageSecretRef", "aiProvider", "aiModel", "aiSecretRef", "aliceTenantCode", "aliceModelPreset", "previewThemePrimary", "previewThemeAccent", "previewThemeBackground", "previewThemeSurface", "status"];
  const body = Object.fromEntries(keys.filter(key => Object.hasOwn(profile, key)).map(key => [key, profile[key]]));
  const scheme = String(profile.hostUrl).startsWith("https://") ? "https" : "http";
  return { ...body, clientId, hostUrl: value.host ? `${scheme}://${value.host}` : profile.hostUrl,
    databaseHost: value.databaseMode === "manual" ? value.databaseHost : profile.databaseHost || value.host,
    clientAdminName: value.clientAdminName, clientAdminLogin: value.clientAdminLogin, clientAdminPassword: value.clientAdminPassword || undefined,
    systemAdminLogin: value.systemAdminLogin, systemAdminPassword: value.systemAdminPassword || undefined };
}
