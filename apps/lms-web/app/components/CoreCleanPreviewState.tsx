"use client";

import { useEffect } from "react";
import { connectCoreEditorState } from "../lib/core-editor-state";

// Error and empty pages have no editable draft. Core may leave them after a fresh bound handshake.
export function CoreCleanPreviewState({ clientId }: { clientId: string | null }): null {
  useEffect(() => connectCoreEditorState(window, clientId, () => ({ dirty: false, busy: false, blocked: false })), [clientId]);
  return null;
}
