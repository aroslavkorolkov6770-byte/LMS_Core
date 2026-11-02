"use client";

import { useEffect, useRef } from "react";
import { connectCoreClientSelection } from "./client-selection-channel";

export function CoreClientSelection({ id, name, blocked, dirty, busy }: { id: string | null; name: string; blocked: boolean; dirty: boolean; busy: boolean }): null {
  const current = useRef<{ id: string; name: string } | null>(null);
  const state = useRef({ dirty, busy, blocked });
  const channel = useRef<ReturnType<typeof connectCoreClientSelection> | null>(null);
  current.current = !blocked && id ? { id, name } : null;
  state.current = { dirty, busy, blocked };
  useEffect(() => {
    channel.current = connectCoreClientSelection(window, () => current.current, () => state.current);
    return () => { channel.current?.close(); channel.current = null; };
  }, []);
  useEffect(() => { channel.current?.publish(); }, [id, name, blocked]);
  return null;
}
