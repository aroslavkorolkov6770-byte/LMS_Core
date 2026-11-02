"use client";

import { useEffect, useRef, useState } from "react";
import { PREVIEW_EDITOR_SOURCE, PREVIEW_RUNTIME_SOURCE } from "../../lib/preview-draft-store";
import { buildClientSiteFrameUrl, type ClientSiteDesign } from "../../lib/client-site-design";

export function ClientSiteView({ design }: { design: ClientSiteDesign }): React.ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const revisionRef = useRef(0);
  const deadlineRef = useRef(0);
  const latestRef = useRef(design);
  const [navigation, setNavigation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const src = `${buildClientSiteFrameUrl(design)}&previewViewNavigation=${navigation}`;

  function sendDesign(): void {
    if (!readyRef.current || !frameRef.current?.contentWindow) return;
    frameRef.current.contentWindow.postMessage({ source: PREVIEW_EDITOR_SOURCE, type: "apply-draft", version: 1, ...latestRef.current, revision: ++revisionRef.current }, window.location.origin);
  }

  function startDeadline(): void {
    window.clearTimeout(deadlineRef.current);
    deadlineRef.current = window.setTimeout(() => {
      readyRef.current = false;
      setLoading(false);
      setError("LMS не ответила вовремя. Проверь локальные сервисы и повтори загрузку.");
    }, 30000);
  }

  useEffect(() => {
    readyRef.current = false;
    setLoading(true); setError("");
    startDeadline();
    return () => window.clearTimeout(deadlineRef.current);
  }, [src]);

  useEffect(() => {
    latestRef.current = design;
    const frame = window.requestAnimationFrame(sendDesign);
    return () => window.cancelAnimationFrame(frame);
  }, [design]);

  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== window.location.origin || event.data?.source !== PREVIEW_RUNTIME_SOURCE || event.data.clientId !== latestRef.current.clientId) return;
      if (event.data.type === "frame-ready") { readyRef.current = true; sendDesign(); return; }
      if (event.data.revision !== revisionRef.current) return;
      if (event.data.type === "draft-applied" || event.data.type === "draft-rejected") {
        window.clearTimeout(deadlineRef.current);
        setLoading(false);
        setError(event.data.type === "draft-rejected" ? "Сохраненное оформление не удалось применить. Открой редактор клиента и проверь настройки." : "");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  function frameLoaded(): void {
    readyRef.current = false;
    try {
      const child = frameRef.current?.contentWindow;
      const contentType = frameRef.current?.contentDocument?.contentType;
      if (!child || child.location.origin !== window.location.origin || (contentType && contentType !== "text/html")) {
        window.clearTimeout(deadlineRef.current); setLoading(false); setError(""); return;
      }
      const location = new URL(child.location.href);
      const knownPage = ["/", "/login", "/tasks", "/profile", "/admin"].includes(location.pathname);
      if (!knownPage) { window.clearTimeout(deadlineRef.current); setLoading(false); setError(""); return; }
      if (location.searchParams.get("previewClientId") !== latestRef.current.clientId || location.searchParams.get("previewReadonly") !== "1") {
        child.location.replace(buildClientSiteFrameUrl(latestRef.current, `${location.pathname}${location.search}${location.hash}`));
        return;
      }
      setLoading(true); setError(""); startDeadline();
      child.postMessage({ source: PREVIEW_EDITOR_SOURCE, type: "request-ready", clientId: latestRef.current.clientId }, window.location.origin);
    } catch {
      // A document on another origin is a view-only resource, never an editor message target.
      window.clearTimeout(deadlineRef.current); setLoading(false); setError("");
    }
  }

  return (
    <main className="client-site-view">
      <iframe ref={frameRef} className="client-site-frame" src={src} title={`Локальная LMS: ${design.brandName}`} onLoad={frameLoaded} onError={() => { window.clearTimeout(deadlineRef.current); setLoading(false); setError("Не удалось открыть локальную LMS. Повтори загрузку."); }} />
      {loading || error ? <section className="client-site-cover" role="status" aria-live="polite">
        <div><strong>{error ? "Не удалось открыть LMS" : "Открываю LMS..."}</strong>{error ? <><p>{error}</p><button type="button" onClick={() => setNavigation((current) => current + 1)}>Повторить загрузку</button><button type="button" onClick={() => window.location.reload()}>Обновить сохраненные настройки</button></> : null}</div>
      </section> : null}
      <style jsx>{`
        .client-site-view { position: fixed; inset: 0; background: #0b1118; }
        .client-site-frame { display: block; width: 100%; height: 100%; border: 0; }
        .client-site-cover { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; background: #0b1118; color: #e9eff5; font-family: Georgia, serif; }
        .client-site-cover > div { max-width: 550px; text-align: center; line-height: 1.6; }
        .client-site-cover strong { font-size: 23px; }
        .client-site-cover p { color: #bcc9d5; }
        .client-site-cover button { margin: 5px; padding: 10px 14px; border: 1px solid #6c8498; border-radius: 8px; background: #1b2935; color: #edf2f5; cursor: pointer; font: 13px Verdana, sans-serif; }
      `}</style>
    </main>
  );
}
