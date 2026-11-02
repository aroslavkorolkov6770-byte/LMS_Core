"use client";

import { useLayoutEffect } from "react";
import { createPointRuntime } from "../lib/corePointRuntime";
import catalog from "../lib/corePointCatalog.json";

export type PointDocument = { elements: Record<string, unknown> };

// Installed sites contain only the passive patcher, not Core's inspector or IPC bridge.
export default function CorePointDesign({ design }: { design: PointDocument }) {
  useLayoutEffect(() => {
    const runtime = createPointRuntime(window, catalog, design);
    return () => runtime.dispose();
  }, [design]);
  return null;
}
