"use client";
import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { isPreviewLocation } from '@/app/lib/preview-runtime';

export default function CookieBanner() {
  const [show, setShow] = useState(false);
  const pathname = usePathname();
  const isEditorShell = pathname === '/preview' || pathname.startsWith('/client/');

  useEffect(() => {
    if (isEditorShell || (typeof window !== 'undefined' && isPreviewLocation(window.location.search))) {
      setShow(false);
      return;
    }

    // Проверяем, делал ли пользователь выбор ранее (ищем и в постоянной, и в сессионной памяти)
    let localConsent: string | null = null;
    let sessionConsent: string | null = null;
    try { localConsent = localStorage.getItem('cookieConsent'); } catch { /* Storage can be blocked by the browser. */ }
    try { sessionConsent = sessionStorage.getItem('cookieConsent'); } catch { /* Keep the page usable without persistence. */ }
    
    // Если выбора нет, показываем плашку с небольшой задержкой в 1 секунду
    if (!localConsent && !sessionConsent) {
      const timer = setTimeout(() => setShow(true), 1000);
      return () => clearTimeout(timer);
    }
  }, [isEditorShell, pathname]);

  const handleAccept = () => {
    try { localStorage.setItem('cookieConsent', 'true'); } catch {
      try { sessionStorage.setItem('cookieConsent', 'true'); } catch { /* No persistent browser storage is available. */ }
    }
    setShow(false);
  };

  const handleDecline = () => {
    try { sessionStorage.setItem('cookieConsent', 'false'); } catch { /* The visible choice still closes this banner. */ }
    setShow(false);
  };

  if (!show || isEditorShell) return null;

  return (
    <>
      <div style={bannerStyle as any}>
        <h3 style={{ margin: '0 0 10px 0', fontSize: '18px', color: '#0abab5', fontWeight: '900' }}>Авторизация и сессия </h3>
        <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: '#ccc', lineHeight: '1.5' }}>
          Мы используем файлы cookie для сохранения вашей сессии. Согласны ли вы оставаться в системе на этом устройстве, чтобы не вводить логин и пароль каждый раз?
        </p>
        
        <p style={{ margin: '0 0 20px 0', fontSize: '11px', color: '#888', lineHeight: '1.5' }}>
          Ознакомьтесь с <a href="/privacy?doc=privacy#privacy" style={linkStyle}>Политикой конфиденциальности</a> и <a href="/privacy?doc=cookies#cookies" style={linkStyle}>Соглашением с файлами cookie</a>.
        </p>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={handleAccept} style={btnYes as any}>ДА, СОГЛАСЕН</button>
          <button onClick={handleDecline} style={btnNo as any}>НЕТ (только на сеанс)</button>
        </div>
      </div>

      <style jsx global>{`
        @keyframes slideInRightCookie {
          from { transform: translateX(120%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </>
  );
}

// --- СТИЛИ ---
const bannerStyle = {
  position: 'fixed',
  bottom: '30px',
  right: '30px',
  width: '320px',
  background: '#111',
  border: '1px solid #333',
  borderRadius: '20px',
  padding: '25px',
  boxShadow: '0 15px 40px rgba(0,0,0,0.8)',
  zIndex: 50000,
  animation: 'slideInRightCookie 0.6s cubic-bezier(0.25, 1, 0.5, 1) forwards'
};

const linkStyle = {
  color: '#0abab5',
  textDecoration: 'underline',
  cursor: 'pointer',
  fontWeight: 'bold',
  transition: '0.2s'
};

const btnYes = {
  flex: 1, padding: '12px', background: '#0abab5', color: '#000', border: 'none', borderRadius: '12px', fontWeight: '900', cursor: 'pointer', fontSize: '11px', transition: '0.2s'
};

const btnNo = {
  flex: 1, padding: '12px', background: 'transparent', color: '#888', border: '1px solid #444', borderRadius: '12px', fontWeight: '900', cursor: 'pointer', fontSize: '11px', transition: '0.2s'
};
