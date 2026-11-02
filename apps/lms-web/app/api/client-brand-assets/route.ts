import { NextRequest, NextResponse } from "next/server";
import { trustedBrandingUpload } from "../../lib/branding-upload-request";

const MAX_BYTES = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FILE = /^[a-f0-9]{64}\.(png|jpg|webp)$/;
function backendHeaders(): HeadersInit {
  return { "x-dev-role-code": "system_admin", "x-dev-user-id": process.env.DEPLOY_PANEL_DEV_USER_ID || "dev-user", "x-dev-client-id": process.env.DEPLOY_PANEL_DEV_CLIENT_ID || "dev-client" };
}
async function bytes(request: NextRequest): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES || !request.body) throw Error("SIZE");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw Error("SIZE"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function POST(request: NextRequest): Promise<NextResponse> {
  const clientId = request.nextUrl.searchParams.get("clientId") || "";
  if (!UUID.test(clientId) || !trustedBrandingUpload(request.headers)) return NextResponse.json({ message: "Запрос загрузки отклонен." }, { status: 403 });
  try {
    const body = await bytes(request);
    const response = await fetch(`${process.env.DEPLOY_PANEL_API_URL || "http://127.0.0.1:3001"}/api/deploy-panel/branding-assets?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { ...backendHeaders(), "Content-Type": "application/octet-stream" }, body: new Uint8Array(body), signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]), redirect: "error", cache: "no-store" });
    if (!response.ok) return NextResponse.json({ message: "Файл не принят. Нужен корректный PNG, JPEG или WebP до 4 МБ." }, { status: response.status >= 400 && response.status < 500 ? response.status : 503 });
    const payload = await response.json();
    if (payload.clientId !== clientId || !FILE.test(payload.asset || "") || payload.url !== `/api/client-brand-assets?clientId=${clientId.toLowerCase()}&asset=${payload.asset}`) throw Error("RESPONSE");
    return NextResponse.json(payload, { status: 201 });
  } catch { return NextResponse.json({ message: "Изображение не загружено. Проверьте размер файла и доступность Core API." }, { status: 503 }); }
}
export async function GET(request: NextRequest): Promise<NextResponse> {
  const clientId = request.nextUrl.searchParams.get("clientId") || "", asset = request.nextUrl.searchParams.get("asset") || "";
  if (!UUID.test(clientId) || !FILE.test(asset)) return new NextResponse(null, { status: 400 });
  try {
    const response = await fetch(`${process.env.DEPLOY_PANEL_API_URL || "http://127.0.0.1:3001"}/api/deploy-panel/branding-assets?clientId=${encodeURIComponent(clientId)}&asset=${asset}`, { headers: backendHeaders(), signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), redirect: "error", cache: "no-store" });
    if (!response.ok) return new NextResponse(null, { status: response.status === 404 ? 404 : 503 });
    const mime = response.headers.get("content-type") || "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime) || Number(response.headers.get("content-length") || 0) > MAX_BYTES) throw Error("IMAGE");
    const body = new Uint8Array(await response.arrayBuffer()); if (body.length > MAX_BYTES) throw Error("SIZE");
    return new NextResponse(body, { headers: { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable" } });
  } catch { return new NextResponse(null, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
