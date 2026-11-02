import { requestPanel } from "./panel-request";

/** The local control-plane headers stay on the server, never in the browser request or query. */
export async function requestPanelBackend(endpoint: string, init: RequestInit = {}, timeoutMs = 10000): ReturnType<typeof requestPanel> {
  if (!endpoint.startsWith("/api/deploy-panel/")) throw new Error("Unsupported control-plane endpoint");
  const headers = new Headers(init.headers);
  headers.set("x-dev-role-code", "system_admin");
  headers.set("x-dev-user-id", process.env.DEPLOY_PANEL_DEV_USER_ID ?? "dev-user");
  headers.set("x-dev-client-id", process.env.DEPLOY_PANEL_DEV_CLIENT_ID ?? "dev-client");
  return requestPanel(`${process.env.DEPLOY_PANEL_API_URL ?? "http://127.0.0.1:3001"}${endpoint}`, { ...init, headers }, init.signal ?? new AbortController().signal, timeoutMs);
}
