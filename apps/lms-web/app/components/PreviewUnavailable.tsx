import { CoreCleanPreviewState } from "./CoreCleanPreviewState";

export function PreviewUnavailable({ message, retryHref, clientId }: { message: string; retryHref: string; clientId?: string }): React.ReactElement {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 28, background: "radial-gradient(ellipse at 50% 0%, #1e2935, #0b1118 70%)", color: "#edf2f6", fontFamily: "Georgia, serif" }}>
      {clientId !== undefined ? <CoreCleanPreviewState clientId={clientId} /> : null}
      <section role="alert" style={{ maxWidth: 580, padding: "34px 36px", border: "1px solid #344252", borderRadius: 20, background: "#151e28" }}>
        <p style={{ margin: "0 0 12px", color: "#c8d6e4", font: "12px Verdana, sans-serif", letterSpacing: "0.1em" }}>LMS CORE</p>
        <h1 style={{ margin: "0 0 18px", fontSize: 30 }}>Не удалось открыть LMS</h1>
        <p style={{ margin: "0 0 24px", color: "#c1ccd7", lineHeight: 1.7, fontSize: 16 }}>{message}</p>
        <a href={retryHref} style={{ display: "inline-block", padding: "11px 17px", border: "1px solid #6b879e", borderRadius: 9, color: "#edf2f6", textDecoration: "none", font: "14px Verdana, sans-serif" }}>Повторить загрузку</a>
      </section>
    </main>
  );
}
