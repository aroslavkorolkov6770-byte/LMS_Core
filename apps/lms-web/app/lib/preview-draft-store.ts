"use client";

import { DEFAULT_CLIENT_PREVIEW_SETTINGS, mergeClientPreviewSettings, type ClientPreviewSettings } from "@lms-core/shared";
import { getIndustryTemplateShortLabel } from "./industry-options";
import { getPreviewFeatureFlags, readPreviewRuntime, type PreviewRuntimeConfig } from "./preview-runtime";

export const PREVIEW_EDITOR_SOURCE = "lms-preview-editor";
export const PREVIEW_RUNTIME_SOURCE = "lms-preview-runtime";
export type PreviewDraft = { clientId: string; revision: number; brandName: string; tariff: string; industryTemplate: string; settings: ClientPreviewSettings };
type Search = { get(name: string): string | null; toString(): string };
type Listener = () => void;
let current: PreviewDraft | null = null;
let storeVersion = 0;
const listeners = new Set<Listener>();
const baseCache = new Map<string, PreviewRuntimeConfig>();
const liveCache = new Map<string, { version: number; config: PreviewRuntimeConfig }>();

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function normalizePreviewDraft(value: unknown): PreviewDraft | null {
  try {
    if (!record(value) || typeof value.clientId !== "string" || value.clientId.length > 128 || !value.clientId ||
        !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.brandName !== "string" || value.brandName.length > 10000 ||
        typeof value.tariff !== "string" || value.tariff.length > 64 || typeof value.industryTemplate !== "string" || value.industryTemplate.length > 64 || !record(value.settings)) return null;
    // Keep public design values only. Large/malformed messages must not freeze the editor frame.
    if (JSON.stringify(value).length > 512 * 1024) return null;
    const settings = mergeClientPreviewSettings(value.settings);
    for (const group of ["theme", "typography", "content", "layout", "components"] as const) {
      const input = settings[group] as unknown as Record<string, unknown>;
      const defaults = DEFAULT_CLIENT_PREVIEW_SETTINGS[group] as unknown as Record<string, unknown>;
      for (const [key, fallback] of Object.entries(defaults)) {
        const candidate = input[key];
        if (typeof fallback === "string" && (typeof candidate !== "string" || candidate.length > 100000)) return null;
        if (typeof fallback === "number" && (typeof candidate !== "number" || !Number.isFinite(candidate))) return null;
        if (typeof fallback === "boolean" && typeof candidate !== "boolean") return null;
        if (Array.isArray(fallback) && !Array.isArray(candidate)) return null;
      }
    }
    if (Object.keys(settings.elementOverrides).length > 256) return null;
    const publicSettings = { ...settings };
    for (const group of ["theme", "typography", "content", "layout", "components"] as const) {
      Object.assign(publicSettings, { [group]: Object.fromEntries(Object.keys(DEFAULT_CLIENT_PREVIEW_SETTINGS[group]).map((key) => [key, (settings[group] as unknown as Record<string, unknown>)[key]])) });
    }
    return { clientId: value.clientId, revision: Number(value.revision), brandName: value.brandName, tariff: value.tariff, industryTemplate: value.industryTemplate, settings: publicSettings };
  } catch { return null; }
}

export function subscribePreviewDraft(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPreviewDraftVersion(): number { return storeVersion; }
export function getServerPreviewDraftVersion(): number { return 0; }
export function getPreviewDraft(clientId: string | null): PreviewDraft | null { return current?.clientId === clientId ? current : null; }

function notify(): void {
  storeVersion++;
  liveCache.clear();
  listeners.forEach((listener) => listener());
}

export function receivePreviewDraft(value: unknown, clientId: string): boolean {
  const next = normalizePreviewDraft(value);
  if (!next || next.clientId !== clientId || (current?.clientId === clientId && next.revision <= current.revision)) return false;
  current = next;
  notify();
  return true;
}

export function clearPreviewDraft(clientId: string): void {
  if (current?.clientId === clientId) { current = null; notify(); }
}

function trimCache<T>(cache: Map<string, T>): void {
  if (cache.size > 8) cache.delete(cache.keys().next().value as string);
}

export function getLivePreviewRuntime(search: Search, version = storeVersion): PreviewRuntimeConfig {
  const key = search.toString();
  const cached = liveCache.get(key);
  if (cached?.version === version) return cached.config;
  let base = baseCache.get(key);
  if (!base) { base = readPreviewRuntime(search); baseCache.set(key, base); trimCache(baseCache); }
  // Hydration uses version0 even if a layout effect has already received a message.
  const draft = version > 0 && base.enabled && base.editable ? getPreviewDraft(base.clientId) : null;
  const config = draft ? {
    ...base, brandName: draft.brandName, tariff: draft.tariff, industryTemplate: draft.industryTemplate,
    industryLabel: getIndustryTemplateShortLabel(draft.industryTemplate), design: draft.settings,
    palette: { primary: draft.settings.theme.primary, accent: draft.settings.theme.accent, background: draft.settings.theme.background, surface: draft.settings.theme.surface, button: draft.settings.theme.button },
    features: getPreviewFeatureFlags(draft.tariff)
  } : base;
  liveCache.set(key, { version, config }); trimCache(liveCache);
  return config;
}

export function connectPreviewDrafts(host: Window, clientId: string, ready: () => void, applied: () => void = () => {}): () => void {
  const receive = (event: MessageEvent): void => {
    if (host.parent === host || event.source !== host.parent || event.origin !== host.location.origin ||
        event.data?.source !== PREVIEW_EDITOR_SOURCE || event.data?.clientId !== clientId) return;
    if (event.data.type === "request-ready") { ready(); return; }
    if (event.data.type !== "apply-draft" || event.data.version !== 1) return;
    if (current?.clientId === clientId && typeof event.data.revision === "number" && event.data.revision <= current.revision) return;
    const accepted = receivePreviewDraft(event.data, clientId);
    if (accepted) applied();
    host.parent.postMessage({ source: PREVIEW_RUNTIME_SOURCE, type: accepted ? "draft-applied" : "draft-rejected", clientId, revision: event.data.revision }, host.location.origin);
  };
  host.addEventListener("message", receive);
  return () => { host.removeEventListener("message", receive); clearPreviewDraft(clientId); };
}
