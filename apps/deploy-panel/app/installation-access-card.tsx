"use client";
import { useEffect, useRef, useState } from "react";
import { installationAccessRequest } from "./installation-access-channel";

export const emptyConnectionAccess = { sshUsername: "root", sshPort: 22, sshPassword: "", databaseMode: "local_peer", databaseHost: "", databasePort: 5432, databaseUser: "postgres", databasePassword: "" };
export type ConnectionAccess = typeof emptyConnectionAccess;

export function ConnectionAccessFields({ value, onChange, saved = {} }: { value: ConnectionAccess; onChange: (value: ConnectionAccess) => void; saved?: Record<string, boolean> }) {
  return <>
    <div className="access-group-title">SSH — доступ к серверу</div>
    <div className="form-grid">
      <label><span>Пользователь SSH</span><input value={value.sshUsername} onChange={event => onChange({ ...value, sshUsername: event.target.value })} autoComplete="off" /></label>
      <label><span>Порт SSH</span><input type="number" min="1" max="65535" value={value.sshPort} onChange={event => onChange({ ...value, sshPort: Number(event.target.value) })} /></label>
      <label className="access-wide"><span>Пароль сервера {saved.sshPassword ? "· сохранён" : ""}</span><input type="password" value={value.sshPassword} placeholder={saved.sshPassword ? "Оставьте пустым, чтобы сохранить прежний" : "Пароль SSH, не пароль LMS"} onChange={event => onChange({ ...value, sshPassword: event.target.value })} autoComplete="new-password" /></label>
    </div>
    <div className="access-group-title">База данных</div>
    <div className="form-grid"><label className="access-wide"><span>Как создавать БД</span><select value={value.databaseMode} onChange={event => onChange({ ...value, databaseMode: event.target.value })}><option value="local_peer">На том же сервере — автоматически, без пароля postgres</option><option value="manual">Отдельный PostgreSQL — административный доступ</option></select></label></div>
    {value.databaseMode === "manual" ? <div className="form-grid">
      <label><span>Хост PostgreSQL</span><input value={value.databaseHost} onChange={event => onChange({ ...value, databaseHost: event.target.value })} /></label>
      <label><span>Порт PostgreSQL</span><input type="number" min="1" max="65535" value={value.databasePort} onChange={event => onChange({ ...value, databasePort: Number(event.target.value) })} /></label>
      <label><span>Администратор PostgreSQL</span><input value={value.databaseUser} onChange={event => onChange({ ...value, databaseUser: event.target.value })} autoComplete="off" /></label>
      <label><span>Пароль PostgreSQL {saved.databasePassword ? "· сохранён" : ""}</span><input type="password" value={value.databasePassword} placeholder={saved.databasePassword ? "Сохранён, повторять не нужно" : "Не пароль SSH"} onChange={event => onChange({ ...value, databasePassword: event.target.value })} autoComplete="new-password" /></label>
    </div> : <p className="access-help">Core сам создаст отдельные БД, SQL-пользователя и служебный пароль. Этот пароль вводить не нужно.</p>}
  </>;
}

export function InstallationAccessCard({ clientId, blocked, onSaved, onState }: { clientId: string; blocked: boolean; onSaved: () => void; onState: (value: { dirty: boolean; busy: boolean }) => void }) {
  const [draft, setDraft] = useState<any>(null);
  const [baseline, setBaseline] = useState("");
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const callbacks = useRef({ onSaved, onState }); callbacks.current = { onSaved, onState };
  const alive = useRef(true);
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const original = baseline ? JSON.parse(baseline) : {};
  const matchingSaved = { ...saved,
    clientAdminPassword: Boolean(saved.clientAdminPassword && draft?.clientAdminLogin === original.clientAdminLogin),
    systemAdminPassword: Boolean(saved.systemAdminPassword && draft?.systemAdminLogin === original.systemAdminLogin),
    sshPassword: Boolean(saved.sshPassword && ["host", "sshUsername", "sshPort"].every(key => draft?.[key] === original[key])),
    databasePassword: Boolean(saved.databasePassword && ["databaseMode", "databaseHost", "databasePort", "databaseUser"].every(key => draft?.[key] === original[key])) };
  function accept(result: any) {
    if (result.clientId !== clientId) throw Error("Core вернул доступы другого клиента.");
    const next = { ...emptyConnectionAccess, ...result.values, clientAdminPassword: "", systemAdminPassword: "", sshPassword: "", databasePassword: "" };
    setDraft(next); setBaseline(JSON.stringify(next)); setRevision(result.revision); setSaved(result.saved);
  }
  async function load() {
    setBusy(true); setError("");
    try { const result = await installationAccessRequest("get", clientId); if (alive.current) accept(result); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "Доступы не прочитаны."); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; callbacks.current.onState({ dirty: false, busy: false }); }; }, [clientId]);
  useEffect(() => { callbacks.current.onState({ dirty, busy }); }, [dirty, busy]);
  async function save() {
    if (!draft || blocked || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await installationAccessRequest("save", clientId, draft, revision);
      if (!alive.current) return;
      accept(result); setMessage("Доступы сохранены. При установке вводить их повторно не нужно."); callbacks.current.onSaved();
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "Сохранение не подтверждено."); }
    finally { if (alive.current) setBusy(false); }
  }
  return <section className="form-section credentials-card" aria-labelledby="client-access-title">
    <div className="form-section-head"><h3 id="client-access-title"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>Пароли и доступы</h3><p>Сохраняются для этого клиента в защищённом хранилище Windows. Пустое поле оставляет прежний пароль. Изменения применяются при следующей установке, не меняют вход в уже работающую LMS.</p></div>
    {draft ? <fieldset disabled={blocked || busy} className="access-fieldset">
      <div className="form-grid"><label className="access-wide"><span>IP или имя сервера клиента</span><input value={draft.host} onChange={event => setDraft({ ...draft, host: event.target.value.trim() })} placeholder="IP из карточки подставится автоматически" /></label></div>
      <div className="form-grid">
        <label><span>Имя администратора LMS</span><input value={draft.clientAdminName} maxLength={150} onChange={event => setDraft({ ...draft, clientAdminName: event.target.value })} /></label>
        <label><span>Логин администратора LMS</span><input value={draft.clientAdminLogin} pattern="[a-zA-Z0-9][a-zA-Z0-9_.@+\-]*" maxLength={120} onChange={event => setDraft({ ...draft, clientAdminLogin: event.target.value })} /></label>
        <label><span>Пароль администратора {matchingSaved.clientAdminPassword ? "· сохранён" : "· нужно сохранить"}</span><input type="password" minLength={12} maxLength={128} autoComplete="new-password" value={draft.clientAdminPassword} placeholder="12–128 символов" onChange={event => setDraft({ ...draft, clientAdminPassword: event.target.value })} /></label>
        <label><span>Логин системного администратора</span><input value={draft.systemAdminLogin} maxLength={120} placeholder="Без пробелов, например system_admin" onChange={event => setDraft({ ...draft, systemAdminLogin: event.target.value })} /></label>
        <label><span>Пароль системного администратора {matchingSaved.systemAdminPassword ? "· сохранён" : "· нужно сохранить"}</span><input type="password" minLength={12} maxLength={128} autoComplete="new-password" value={draft.systemAdminPassword} placeholder="12–128 символов" onChange={event => setDraft({ ...draft, systemAdminPassword: event.target.value })} /></label>
      </div>
      <ConnectionAccessFields value={draft} saved={matchingSaved} onChange={next => setDraft(next)} />
      <div className="form-actions"><button type="button" onClick={() => void save()}>{busy ? "Сохранение..." : "Сохранить доступы клиента"}</button></div>
    </fieldset> : null}
    {blocked ? <p className="access-help">Сначала сохраните или отмените другие изменения карточки.</p> : null}
    {error ? <p className="message-error" role="alert">{error}</p> : null}{message ? <p className="message-success" role="status">{message}</p> : null}
    {!draft ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void load()}>Перечитать доступы</button> : null}
  </section>;
}
