"use client";
import React, { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let address = "", checkedAt = 0, pending: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const validEmail = (value: unknown): value is string => typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);

async function refresh() {
  if (document.hidden || pending || Date.now() - checkedAt < 5000) return;
  pending = (async () => {
    try {
      const response = await fetch("/api/core-runtime/support-contact", { cache: "no-store", redirect: "error", credentials: "same-origin", signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!response.ok || result?.protocol !== "lms-core-support-contact-v1" || result.supportEmail !== null && !validEmail(result.supportEmail)) throw Error("Invalid contact response");
      const next = result.supportEmail || "";
      if (next !== address) { address = next; for (const listener of listeners) listener(); }
    } catch { /* Keep the last confirmed contact; never fall back to a pilot address or SMTP secret. */ }
    finally { checkedAt = Date.now(); pending = null; }
  })();
  await pending;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    timer = setInterval(refresh, 60000); void refresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); }
  };
}

function useSupportEmail() { return useSyncExternalStore(subscribe, () => address, () => ""); }

export function SupportEmail({ className, emptyLabel = "Почта поддержки не настроена" }: { className?: string; emptyLabel?: string }) {
  const email = useSupportEmail();
  return <a className={className} data-core-support-contact="v1" href={email ? `mailto:${email}` : undefined}>{email || emptyLabel}</a>;
}

export function SupportText({ text, emptyLabel = "адрес поддержки уточняется" }: { text: string; emptyLabel?: string }) {
  const email = useSupportEmail(), parts = text.split("__CORE_SUPPORT_EMAIL__");
  return <>{parts.map((part, index) => <React.Fragment key={index}>{part}{index < parts.length - 1 ? <a data-core-support-contact="v1" href={email ? `mailto:${email}` : undefined}>{email || emptyLabel}</a> : null}</React.Fragment>)}</>;
}
