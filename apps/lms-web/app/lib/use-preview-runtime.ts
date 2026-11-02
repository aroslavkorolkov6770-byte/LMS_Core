"use client";

import { useSyncExternalStore } from "react";
import { getLivePreviewRuntime, getPreviewDraftVersion, getServerPreviewDraftVersion, subscribePreviewDraft } from "./preview-draft-store";
import type { PreviewRuntimeConfig } from "./preview-runtime";

export function usePreviewRuntime(search: { get(name: string): string | null; toString(): string }): PreviewRuntimeConfig {
  const version = useSyncExternalStore(subscribePreviewDraft, getPreviewDraftVersion, getServerPreviewDraftVersion);
  return getLivePreviewRuntime(search, version);
}
