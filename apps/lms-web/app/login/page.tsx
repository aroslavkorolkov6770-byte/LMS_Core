"use client";
import React, { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import CustomIcon from '@/app/components/CustomIcon';
import { getPreviewElementStyle } from '@/app/lib/preview-element-style';
import { appendPreviewParams } from '@/app/lib/preview-runtime';
import { usePreviewRuntime } from '@/app/lib/use-preview-runtime';

// --- ХЕЛПЕРЫ ДЛЯ РАБОТЫ С COOKIES ---
const setAppCookie = (name: string, value: string, days: number | null = 7) => {
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        document.cookie = `${name}=${encodeURIComponent(value)};expires=${date.toUTCString()};path=/`;
    } else {
        document.cookie = `${name}=${encodeURIComponent(value)};path=/`;
    }
};

const saveDataToServer = async (key: string, data: any) => {
    try {
        await fetch('/api/storage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, data })
        });
    } catch (err) {
        console.error("Ошибка сохранения на сервер:", err);
    }
};

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preview = usePreviewRuntime(searchParams);
  const design = preview.design;
  const previewPrimary = preview.palette.primary;
  const [isMounted, setIsMounted] = useState(false);

  // Состояния режимов и инпутов
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [login, setLogin] = useState("");
  const [pass, setPass] = useState("");
  
  const [regName, setRegName] = useState("");
  const [email, setEmail] = useState("");
  const [regTg, setRegTg] = useState("");
  const [regPhone, setRegPhone] = useState("");

  // НОВОЕ: Состояние для галочки согласия
  const [isConsentGiven, setIsConsentGiven] = useState(false);

  // Состояния уведомлений
  const [errorMessage, setErrorMessage] = useState("");
  const [infoMessage, setInfoMessage] = useState("");

  // Состояния TeaGuard
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [isCaptchaVerified, setIsCaptchaVerified] = useState(false);
  const [isCaptchaLoading, setIsCaptchaLoading] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    const auth = localStorage.getItem('isLoggedIn') || sessionStorage.getItem('isLoggedIn');
    const role = localStorage.getItem('userRole') || sessionStorage.getItem('userRole');
    if (auth === 'true') {
        if (role === 'admin') router.push(appendPreviewParams('/admin', searchParams));
        else router.push(appendPreviewParams('/tasks?tab=welcome', searchParams));
    }
  }, [router, searchParams]);

  const navigateAfterAuth = (role: string) => {
      if (role === 'admin') {
          router.push(appendPreviewParams('/admin', searchParams));
          return;
      }

      router.push(appendPreviewParams('/tasks?tab=welcome', searchParams));
  };

  const handleCaptchaClick = () => {
      if (isCaptchaVerified || isCaptchaLoading) return;
      setIsCaptchaLoading(true);
      setTimeout(() => {
          setIsCaptchaLoading(false);
          setIsCaptchaVerified(true);
          setErrorMessage(""); 
      }, 1200);
  };

  const processAuth = (user: any, nameToSave: string) => {
      const hasConsent = localStorage.getItem('cookieConsent') === 'true';

      if (hasConsent) {
          localStorage.setItem('isLoggedIn', 'true');
          localStorage.setItem('userRole', user.role);
          localStorage.setItem('current_user_id', user.id);
          localStorage.setItem('current_user_name', nameToSave);

          setAppCookie('isLoggedIn', 'true', 7);
          setAppCookie('userRole', user.role, 7);
          setAppCookie('current_user_id', user.id, 7);
          setAppCookie('current_user_name', nameToSave, 7);
      } else {
          sessionStorage.setItem('isLoggedIn', 'true');
          sessionStorage.setItem('userRole', user.role);
          sessionStorage.setItem('current_user_id', user.id);
          sessionStorage.setItem('current_user_name', nameToSave);

          setAppCookie('isLoggedIn', 'true', null);
          setAppCookie('userRole', user.role, null);
          setAppCookie('current_user_id', user.id, null);
          setAppCookie('current_user_name', nameToSave, null);
      }

      navigateAfterAuth(user.role);
  };

  const tryBackendAuth = async (action: 'login' | 'register') => {
      if (!preview.clientId) {
          return null;
      }

      const response = await fetch('/api/lms-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              action,
              clientId: preview.clientId,
              login: login.trim(),
              password: pass.trim(),
              name: regName.trim(),
              phone: regPhone.trim()
          })
      });

      if (!response.ok) {
          return null;
      }

      const payload = await response.json();
      return payload?.user ?? null;
  };

  const handleLogin = async () => {
    if (failedAttempts >= 3 && !isCaptchaVerified) {
        setErrorMessage("Пожалуйста, подтвердите, что вы человек.");
        return;
    }

    try {
        const backendUser = await tryBackendAuth('login');

        if (backendUser) {
          setFailedAttempts(0);
          setIsCaptchaVerified(false);
          processAuth(backendUser, backendUser.name);
          return;
        }

        const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_users_v1`);
        let users = await res.json().catch(() => []);
        
        if (!Array.isArray(users) || users.length === 0) {
            users = [
                { id: 'u_admin', login: '11', pass: '11', role: 'admin', name: 'Главный Мастер', isRegistered: true },
                { id: 'u_staff_new', login: '1', pass: '1', role: 'staff', name: '', isRegistered: false }
            ];
            await saveDataToServer('core_lms_users_v1', users);
        }

        const foundUser = users.find((u: any) => u.login === login.trim() && u.pass === pass.trim());

        if (foundUser) {
          if (foundUser.role !== 'admin' && !foundUser.isRegistered) {
              setInfoMessage("Уведомление от платформы: Для начала пройдите регистрацию и заполните ваши данные.");
              setIsLoginMode(false); 
              return;
          }

          setFailedAttempts(0); 
          setIsCaptchaVerified(false);
          processAuth(foundUser, foundUser.name);

        } else {
          const newFails = failedAttempts + 1;
          setFailedAttempts(newFails);
          if (isCaptchaVerified) setIsCaptchaVerified(false);
          setErrorMessage("Неправильно введен логин или пароль!");
        }
    } catch (error) {
        console.error("Ошибка связи с сервером:", error);
        setErrorMessage("Не удалось подключиться к базе данных.");
    }
  };

  const handleRegister = async () => {
      // НОВОЕ: Проверка галочки согласия
      if (!isConsentGiven) {
          setErrorMessage("ОШИБКА: Для регистрации необходимо дать согласие на обработку персональных данных.");
          return;
      }

      if (!regName.trim() || !login.trim() || !pass.trim() || !email.trim() || !regTg.trim() || !regPhone.trim()) {
          setErrorMessage("ОШИБКА: Пожалуйста, заполните абсолютно все поля. Это обязательно для активации аккаунта!");
          return;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
          setErrorMessage("ОШИБКА: Неверный формат E-mail адреса! Убедитесь в правильности знака @ и доменной зоны (например, ivan@mail.ru).");
          return;
      }

      if (failedAttempts >= 3 && !isCaptchaVerified) {
          setErrorMessage("Пожалуйста, подтвердите, что вы человек.");
          return;
      }

      try {
          const backendUser = await tryBackendAuth('register');

          if (backendUser) {
              const initialProfile = {
                  avatar: '',
                  tg: regTg.trim(),
                  phone: regPhone.trim(),
                  email: email.trim(),
                  firstLogin: new Date().toISOString()
              };
              await saveDataToServer(`profile_data_${backendUser.id}`, initialProfile);

              setFailedAttempts(0);
              setIsCaptchaVerified(false);
              setInfoMessage("");
              processAuth(backendUser, backendUser.name);
              return;
          }

          const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_users_v1`);
          let users = await res.json().catch(() => []);
          if (!Array.isArray(users)) users = [];

          const foundUserIndex = users.findIndex((u: any) => u.login === login.trim() && u.pass === pass.trim());

          if (foundUserIndex === -1) {
              const newFails = failedAttempts + 1;
              setFailedAttempts(newFails);
              if (isCaptchaVerified) setIsCaptchaVerified(false);
              setErrorMessage("Ошибка: Учетная запись с таким логином и паролем не найдена. Убедитесь, что администратор выдал вам доступы.");
              return;
          }

          const existingUser = users[foundUserIndex];

          users[foundUserIndex] = { ...existingUser, name: regName.trim(), isRegistered: true };
          await saveDataToServer('core_lms_users_v1', users);

          const initialProfile = {
              avatar: '',
              tg: regTg.trim(),
              phone: regPhone.trim(),
              email: email.trim(),
              firstLogin: new Date().toISOString()
          };
          await saveDataToServer(`profile_data_${existingUser.id}`, initialProfile);

          setFailedAttempts(0); 
          setIsCaptchaVerified(false);
          setInfoMessage("");
          
          processAuth(existingUser, regName.trim());

      } catch (error) {
          console.error("Ошибка при регистрации:", error);
          setErrorMessage("Не удалось подключиться к базе данных для регистрации.");
      }
  };

  if (!isMounted) return null;

  return (
    <div style={{ minHeight: '100vh', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', fontFamily: 'Inter, sans-serif', boxSizing: 'border-box', overflowX: 'hidden', maxWidth: '100vw' }}>
      
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundImage: 'url("https://u.9111s.ru/uploads/202402/17/a0254a12ef37da5aaf5c5646a30baab8.webp")', backgroundSize: 'cover', backgroundPosition: 'center', zIndex: -2, backgroundColor: '#000' }} />
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)', zIndex: -1 }} />

      <Link href={appendPreviewParams('/', searchParams)} style={{ position: 'absolute', top: '30px', left: '40px', color: previewPrimary, textDecoration: 'none', fontWeight: '900', fontSize: '14px', letterSpacing: '1px' }}>
          ← НА ГЛАВНУЮ
      </Link>

      <div
        className="login-box"
        data-preview-editable={preview.enabled ? "login.card" : undefined}
        data-preview-label={preview.enabled ? "Карточка входа" : undefined}
        data-preview-tab={preview.enabled ? "layout" : undefined}
        style={getPreviewElementStyle(design, "login.card", { background: '#0a0a0a', padding: '50px 40px', borderRadius: `${preview.enabled ? design.typography.buttonRadiusPx + 12 : 35}px`, width: '100%', maxWidth: '390px', border: '1px solid #222', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8)', animation: 'scaleIn 0.4s ease', boxSizing: 'border-box' })}
      >
        
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
            <h1
              data-preview-editable={preview.enabled ? "login.title" : undefined}
              data-preview-label={preview.enabled ? "Заголовок входа" : undefined}
              data-preview-tab={preview.enabled ? "content" : undefined}
              style={getPreviewElementStyle(design, "login.title", { margin: 0, color: '#fff', fontSize: '28px', fontWeight: '900', letterSpacing: '1px' })}
            >
                {preview.enabled ? design.content.loginTitle : 'TEA '}
                <span style={{color: previewPrimary}}>{preview.enabled ? '' : 'HUB'}</span>
            </h1>
            <p
              data-preview-editable={preview.enabled ? "login.subtitle" : undefined}
              data-preview-label={preview.enabled ? "Подзаголовок входа" : undefined}
              data-preview-tab={preview.enabled ? "content" : undefined}
              style={getPreviewElementStyle(design, "login.subtitle", { margin: '5px 0 0 0', color: '#666', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold' })}
            >
                {isLoginMode ? (preview.enabled ? design.content.loginSubtitle : 'Вход в платформу') : 'Активация аккаунта'}
            </p>
        </div>

        {infoMessage && (
            <div style={{ background: 'rgba(10, 186, 181, 0.1)', border: '1px solid rgba(10, 186, 181, 0.3)', padding: '15px', borderRadius: '15px', color: '#0abab5', fontSize: '13px', textAlign: 'center', marginBottom: '25px', lineHeight: '1.5', fontWeight: 'bold', animation: 'fadeInUp 0.3s ease' }}>
                {infoMessage}
            </div>
        )}
        
        {!isLoginMode && (
            <input type="text" placeholder="Ваше Имя (для профиля)" value={regName} onChange={(e)=>setRegName(e.target.value)} style={inputS} />
        )}
        
        {isLoginMode ? (
            <>
                <input type="text" placeholder="Логин" value={login} onChange={(e)=>setLogin(e.target.value)} style={inputS} />
                <input type="password" placeholder="Пароль" value={pass} onChange={(e)=>setPass(e.target.value)} style={inputS} onKeyDown={(e) => { if(e.key === 'Enter') { handleLogin() } }} />
            </>
        ) : (
            <div className="auth-inline-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <input type="text" placeholder="Логин (выданный администратором)" value={login} onChange={(e)=>setLogin(e.target.value)} style={{ ...inputS, marginBottom: 0 }} />
                <input type="password" placeholder="Пароль" value={pass} onChange={(e)=>setPass(e.target.value)} style={{ ...inputS, marginBottom: 0 }} onKeyDown={(e) => { if(e.key === 'Enter') { handleRegister() } }} />
            </div>
        )}
        
        {!isLoginMode && (
            <div style={{ animation: 'fadeInUp 0.3s ease' }}>
                <input type="email" placeholder="E-mail адрес" value={email} onChange={(e)=>setEmail(e.target.value)} style={inputS} />
                <input type="text" placeholder="Telegram (напр. @nik_name)" value={regTg} onChange={(e)=>setRegTg(e.target.value)} style={inputS} />
                <input type="text" placeholder="Номер телефона (только цифры)" value={regPhone} onChange={(e)=>setRegPhone(e.target.value.replace(/\D/g, ''))} style={inputS} />

                {/* НОВОЕ: Блок с галочкой согласия */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '5px', marginBottom: '20px' }}>
                    <div 
                        onClick={() => setIsConsentGiven(!isConsentGiven)}
                        style={{ 
                            width: '24px', height: '24px', flexShrink: 0, 
                            border: isConsentGiven ? '2px solid #0abab5' : '2px solid #444', 
                            borderRadius: '6px', background: isConsentGiven ? 'rgba(10,186,181,0.1)' : '#111',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: '0.2s'
                        }}
                    >
                        {isConsentGiven && <span style={{ color: '#0abab5', display: 'inline-flex' }}><CustomIcon name="check" size={16} color="#0abab5" /></span>}
                    </div>
                    <div style={{ color: '#888', fontSize: '12px', lineHeight: '1.4' }}>
                        Я даю согласие на <a href="/privacy?doc=processing#processing" style={{ color: '#0abab5', textDecoration: 'underline' }}>обработку персональных данных</a>
                    </div>
                </div>
            </div>
        )}

        {failedAttempts >= 3 && (
            <div style={{ display: 'flex', justifyContent: 'center', width: '100%', marginBottom: '20px', marginTop: '10px' }}>
                <div style={teaGuardContainerStyle as any}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <div onClick={handleCaptchaClick} style={teaGuardCheckboxStyle(isCaptchaVerified) as any}>
                            {isCaptchaLoading && <div className="captcha-spinner"></div>}
                            {isCaptchaVerified && <span style={{ color: '#0abab5', display: 'inline-flex' }}><CustomIcon name="check" size={24} color="#0abab5" /></span>}
                        </div>
                        <span style={{ color: '#fff', fontSize: '15px', fontWeight: '500' }}>Я человек</span>
                    </div>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#0abab5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            <rect x="9" y="11" width="6" height="5" rx="1" stroke="#0abab5" strokeWidth="1.5"/>
                            <path d="M10 11V9a2 2 0 014 0v2" stroke="#0abab5" strokeWidth="1.5" strokeLinecap="round"/>
                            <circle cx="12" cy="13.5" r="1" fill="#0abab5"/>
                        </svg>
                        <div style={{ color: '#fff', fontSize: '11px', fontWeight: '900', marginTop: '4px', letterSpacing: '0.5px' }}>TeaGuard</div>
                        <div style={{ color: '#666', fontSize: '9px', marginTop: '2px' }}>by LMS Core</div>
                    </div>
                </div>
            </div>
        )}
        
        {isLoginMode ? (
            <button
              data-preview-editable={preview.enabled ? "login.primaryAction" : undefined}
              data-preview-label={preview.enabled ? "Главная кнопка входа" : undefined}
              data-preview-tab={preview.enabled ? "layout" : undefined}
              onClick={handleLogin}
              style={getPreviewElementStyle(design, "login.primaryAction", {
                ...(modalLoginBtn as React.CSSProperties),
                background: preview.enabled ? design.theme.button : modalLoginBtn.background,
                color: preview.enabled ? design.theme.buttonText : modalLoginBtn.color,
                borderRadius: preview.enabled ? `${design.typography.buttonRadiusPx}px` : modalLoginBtn.borderRadius,
                fontSize: preview.enabled ? `${design.typography.buttonFontSizePx}px` : modalLoginBtn.fontSize,
                fontFamily: preview.enabled ? `${design.typography.buttonFont}, sans-serif` : undefined
              }) as any}
            >
              {preview.enabled ? design.content.loginButtonLabel.toUpperCase() : 'ВОЙТИ'}
            </button>
        ) : (
            <button
              data-preview-editable={preview.enabled ? "login.primaryAction" : undefined}
              data-preview-label={preview.enabled ? "Главная кнопка регистрации" : undefined}
              data-preview-tab={preview.enabled ? "layout" : undefined}
              onClick={handleRegister}
              style={getPreviewElementStyle(design, "login.primaryAction", {
                ...(modalLoginBtn as React.CSSProperties),
                background: preview.enabled ? design.theme.button : modalLoginBtn.background,
                color: preview.enabled ? design.theme.buttonText : modalLoginBtn.color,
                borderRadius: preview.enabled ? `${design.typography.buttonRadiusPx}px` : modalLoginBtn.borderRadius,
                fontSize: preview.enabled ? `${design.typography.buttonFontSizePx}px` : modalLoginBtn.fontSize,
                fontFamily: preview.enabled ? `${design.typography.buttonFont}, sans-serif` : undefined
              }) as any}
            >
              {preview.enabled ? design.content.registerButtonLabel.toUpperCase() : 'ЗАРЕГИСТРИРОВАТЬСЯ'}
            </button>
        )}
        
        <div style={{ textAlign: 'center', marginTop: '25px' }}>
            <span style={{ color: '#666', fontSize: '13px' }}>
                {isLoginMode ? 'Нет аккаунта или первый вход? ' : 'Уже активировали аккаунт? '}
            </span>
            <span 
                onClick={() => { 
                    setIsLoginMode(!isLoginMode); 
                    setFailedAttempts(0); 
                    setIsCaptchaVerified(false); 
                    setIsCaptchaLoading(false); 
                    setInfoMessage("");
                    setIsConsentGiven(false); // Сброс галочки при смене режима
                }} 
                style={{ color: '#0abab5', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', textDecoration: 'underline' }}
            >
                {isLoginMode ? 'Пройти регистрацию' : 'Войти'}
            </span>
        </div>
      </div>

      {/* --- МОДАЛЬНОЕ ОКНО ОШИБКИ --- */}
      {errorMessage && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40000 }} onClick={() => setErrorMessage("")}>
              <div style={{ background: '#111', padding: '40px 30px', borderRadius: '30px', width: '90%', maxWidth: '380px', border: '1px solid #333', textAlign: 'center', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)', animation: 'scaleIn 0.2s ease' }} onClick={e => e.stopPropagation()}>
                  <div style={warningBadgeStyle as any}><CustomIcon name="alert" size={34} color="#ff4d4d" /></div>
                  <h2 style={{ color: '#ff4d4d', fontSize: '20px', fontWeight: '900', marginBottom: '15px', textTransform: 'uppercase' }}>Ошибка</h2>
                  <p style={{ color: '#ccc', fontSize: '14px', lineHeight: '1.5', marginBottom: '25px' }}>{errorMessage}</p>
                  <div onClick={() => setErrorMessage("")} style={{ width: '100%', padding: '14px', background: '#333', color: '#fff', borderRadius: '14px', fontWeight: '900', cursor: 'pointer', fontSize: '14px', textTransform: 'uppercase', transition: '0.2s' }}>ПОНЯТНО</div>
              </div>
          </div>
      )}

      <style jsx global>{`
        html, body {
          margin: 0;
          padding: 0;
          width: 100%;
          overflow-x: hidden !important;
        }
        @keyframes scaleIn { 
          from { transform: scale(0.9); opacity: 0; } 
          to { transform: scale(1); opacity: 1; } 
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes captchaSpin {
          100% { transform: rotate(360deg); }
        }
        .captcha-spinner {
          width: 18px; height: 18px; border: 3px solid #333;
          border-top-color: #0abab5; border-radius: 50%;
          animation: captchaSpin 1s linear infinite;
        }

        @media (max-width: 768px) {
            .login-box {
                padding: 35px 20px !important;
                max-width: 100% !important;
            }
        }

        @media (max-width: 640px) {
            .auth-inline-row {
                grid-template-columns: 1fr !important;
            }
        }
      `}</style>
    </div>
  );
}

export default function LoginPage() {
    return (
        <Suspense fallback={null}>
            <LoginContent />
        </Suspense>
    );
}

// --- СТИЛИ ИНПУТОВ И КНОПОК ---
const inputS = { 
    width: '100%', 
    padding: '16px 20px', 
    marginBottom: '15px', 
    borderRadius: '16px', 
    background: '#111', 
    border: '1px solid #333', 
    color: '#fff', 
    outline: 'none', 
    fontSize: '16px', // ИСПРАВЛЕНО: 16px предотвращает зум на iOS
    boxSizing: 'border-box' as any,
    transition: '0.2s ease'
};

const modalLoginBtn = { 
    width: '100%', 
    padding: '16px', 
    background: '#0ABAB5', 
    color: '#000', 
    textAlign: 'center', 
    borderRadius: '16px', 
    fontWeight: '900', 
    cursor: 'pointer', 
    fontSize: '15px', 
    textTransform: 'uppercase', 
    marginTop: '10px', 
    border: 'none',
    boxSizing: 'border-box' as any,
    transition: '0.2s ease'
};

const teaGuardContainerStyle = {
    background: '#161816',
    border: '1px solid #333',
    borderRadius: '16px',
    width: '100%',
    height: '78px',
    display: 'flex',
    alignItems: 'center',
    padding: '0 20px',
    justifyContent: 'space-between',
    boxShadow: '0px 4px 10px rgba(0,0,0,0.3)',
    boxSizing: 'border-box'
};

const teaGuardCheckboxStyle = (isVerified: boolean) => ({
    width: '32px',
    height: '32px',
    background: isVerified ? 'transparent' : '#000',
    border: isVerified ? '2px solid #0abab5' : '2px solid #444',
    borderRadius: '6px',
    cursor: isVerified ? 'default' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: '0.2s ease',
    boxShadow: isVerified ? '0 0 10px rgba(10,186,181,0.2)' : 'none'
});

const warningBadgeStyle = {
    width: '60px',
    height: '60px',
    borderRadius: '18px',
    border: '1px solid rgba(255,77,77,0.35)',
    background: 'rgba(255,77,77,0.08)',
    color: '#ff4d4d',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '32px',
    fontWeight: '900',
    margin: '0 auto 15px auto'
};
