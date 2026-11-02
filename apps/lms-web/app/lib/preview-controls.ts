import { PREVIEW_EDITOR_SOURCE } from "./preview-draft-store";

export type PreviewControlState = {
  selectMode: boolean;
  dragMode: boolean;
  selectedId: string | null;
  primary: string;
  accent: string;
  buttonText: string;
  textEditableIds: string[];
  elementOverrides: Record<string, { offsetX?: number; offsetY?: number }>;
};

export const DEFAULT_PREVIEW_CONTROL: PreviewControlState = {
  selectMode: false, dragMode: false, selectedId: null,
  primary: "#0abab5", accent: "#6ee7d8", buttonText: "#081015",
  textEditableIds: [], elementOverrides: {}
};

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);
function validColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128 || /[;{}\\\u0000-\u001f]/.test(value)) return false;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") return CSS.supports("color", value);
  return /^#(?:[a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(value) || /^(?:rgba?|hsla?)\([\d\s.,%+\-]+\)$/i.test(value) || /^(?:transparent|currentcolor|black|white|red|green|blue)$/i.test(value);
}

/** Copy only the small transient control state; it never contains credentials or persisted LMS data. */
export function normalizePreviewControl(value: unknown): PreviewControlState | null {
  try {
    if (!record(value) || JSON.stringify(value).length > 128 * 1024 || typeof value.selectMode !== "boolean" || typeof value.dragMode !== "boolean" ||
      (value.selectedId !== null && !validId(value.selectedId)) || !validColor(value.primary) || !validColor(value.accent) || !validColor(value.buttonText) ||
      !Array.isArray(value.textEditableIds) || value.textEditableIds.length > 256 || !value.textEditableIds.every(validId) || !record(value.elementOverrides) || Object.keys(value.elementOverrides).length > 256) return null;
    const offsets: Record<string, { offsetX?: number; offsetY?: number }> = {};
    for (const [key, item] of Object.entries(value.elementOverrides)) {
      if (!validId(key) || !record(item)) return null;
      if ([item.offsetX, item.offsetY].some((offset) => offset !== undefined && (typeof offset !== "number" || !Number.isFinite(offset)))) return null;
      Object.defineProperty(offsets, key, { value: { offsetX: item.offsetX as number | undefined, offsetY: item.offsetY as number | undefined }, enumerable: true, configurable: true, writable: true });
    }
    return { selectMode: value.selectMode, dragMode: value.dragMode, selectedId: value.selectedId as string | null, primary: value.primary, accent: value.accent, buttonText: value.buttonText, textEditableIds: [...value.textEditableIds], elementOverrides: offsets };
  } catch { return null; }
}

export function connectPreviewControls(host: Window, clientId: string, apply: (control: PreviewControlState) => void): () => void {
  let revision = 0, frame = 0;
  let pending: PreviewControlState | null = null;
  const receive = (event: MessageEvent): void => {
    if (host.parent === host || event.source !== host.parent || event.origin !== host.location.origin || event.data?.source !== PREVIEW_EDITOR_SOURCE ||
      event.data.type !== "apply-controls" || event.data.version !== 1 || event.data.clientId !== clientId || !Number.isSafeInteger(event.data.revision) || event.data.revision <= revision) return;
    const control = normalizePreviewControl(event.data.control);
    if (!control) return;
    revision = event.data.revision;
    pending = control;
    if (!frame) frame = host.requestAnimationFrame(() => { frame = 0; const latest = pending; pending = null; if (latest) apply(latest); });
  };
  host.addEventListener("message", receive);
  return () => { host.removeEventListener("message", receive); if (frame) host.cancelAnimationFrame(frame); pending = null; };
}
