"use client";
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import CustomIcon from '@/app/components/CustomIcon';
import { getIndustryContent } from '@/app/lib/industry-content';
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

const deleteAppCookie = (name: string) => {
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;`;
};

const saveDataToServer = (key: string, data: any) => {
    fetch('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, data })
    }).catch(err => console.error("Ошибка сохранения на сервер:", err));
};

export default function Navigation() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const preview = usePreviewRuntime(searchParams);
  const design = preview.design;
  const primary = preview.palette.primary;
  const buttonColor = design.theme.button;
  const withPreviewPath = (path: string) => appendPreviewParams(path, searchParams);
  const industryContent = getIndustryContent(preview.industryTemplate);
  
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(!preview.enabled);

  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);

  const [isLoginMode, setIsLoginMode] = useState(true);
  const [login, setLogin] = useState("");
  const [pass, setPass] = useState("");
  
  const [regName, setRegName] = useState("");
  const [email, setEmail] = useState("");
  const [regTg, setRegTg] = useState("");
  const [regPhone, setRegPhone] = useState("");

  const [isConsentGiven, setIsConsentGiven] = useState(false);

  const [searchDbRoutes, setSearchDbRoutes] = useState<any[]>([]);
  const [searchDbTests, setSearchDbTests] = useState<any[]>([]);
  const [searchDbAssortment, setSearchDbAssortment] = useState<any[]>([]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [isCaptchaVerified, setIsCaptchaVerified] = useState(false);
  const [isCaptchaLoading, setIsCaptchaLoading] = useState(false);

  const handleCaptchaClick = () => {
      if (isCaptchaVerified || isCaptchaLoading) return;
      setIsCaptchaLoading(true);
      setTimeout(() => {
          setIsCaptchaLoading(false);
          setIsCaptchaVerified(true);
          setErrorMessage(""); 
      }, 1200);
  };

  useEffect(() => {
    if (preview.enabled || (typeof window !== 'undefined' && window.innerWidth <= 768)) {
        setIsSidebarOpen(false);
    }

    const auth = localStorage.getItem('isLoggedIn') || sessionStorage.getItem('isLoggedIn');
    const role = localStorage.getItem('userRole') || sessionStorage.getItem('userRole');
    if (auth === 'true') {
      setIsLoggedIn(true);
      setUserRole(role);
    }

    const loadServerData = async () => {
        try {
            const currentUserId = localStorage.getItem('current_user_id') || sessionStorage.getItem('current_user_id') || 'guest';
            
            const notifsRes = await fetch('/api/storage?key=core_lms_notifications_v1').then(r => r.json()).catch(() => []);
            if (Array.isArray(notifsRes)) {
                const myNotifs = notifsRes.filter((n: any) => n.target === 'Все' || n.target === currentUserId || !n.target);
                setNotifications(myNotifs);
            }

            const rRes = await fetch('/api/storage?key=core_lms_route_v1').then(r => r.json()).catch(() => []);
            if (Array.isArray(rRes) && rRes.length > 0) setSearchDbRoutes(rRes);

            const tRes = await fetch('/api/storage?key=core_lms_tests_v1').then(r => r.json()).catch(() => []);
            if (Array.isArray(tRes) && tRes.length > 0) setSearchDbTests(tRes);

            const aRes = await fetch('/api/storage?key=core_lms_assortment_v1').then(r => r.json()).catch(() => []);
            if (Array.isArray(aRes) && aRes.length > 0) setSearchDbAssortment(aRes);

        } catch (e) {
            console.error("Ошибка синхронизации Navigation:", e);
        }
    };

    loadServerData();
    const syncInterval = setInterval(loadServerData, 5000);
    return () => clearInterval(syncInterval);
  }, [preview.enabled]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('sidebarStateChange', {
        detail: { open: isSidebarOpen }
      })
    );
  }, [isSidebarOpen]);

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

  const completeAuth = (user: any, nameToSave: string) => {
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

      setFailedAttempts(0);
      setIsCaptchaVerified(false);
      setIsLoggedIn(true);
      setUserRole(user.role);
      setShowLoginModal(false);

      if (user.role === 'admin') router.push(withPreviewPath('/admin'));
      else router.push(withPreviewPath('/tasks?tab=welcome'));
  };

  const handleLogin = async () => {
    if (failedAttempts >= 3 && !isCaptchaVerified) {
        setErrorMessage("Пожалуйста, подтвердите, что вы человек.");
        return;
    }

    try {
        const backendUser = await tryBackendAuth('login');

        if (backendUser) {
          completeAuth(backendUser, backendUser.name);
          return;
        }

        const res = await fetch('/api/storage?key=core_lms_users_v1');
        let users = await res.json().catch(() => []);
        
        const foundUser = users.find((u: any) => u.login === login && u.pass === pass);

        if (foundUser) {
          completeAuth(foundUser, foundUser.name);
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
      if (!isConsentGiven) {
          setErrorMessage("ОШИБКА: Для регистрации необходимо дать согласие на обработку персональных данных.");
          return;
      }

      if (!regName.trim() || !login.trim() || !pass.trim()) {
          setErrorMessage("Пожалуйста, заполните Имя, Логин и Пароль!");
          return;
      }
      try {
          const backendUser = await tryBackendAuth('register');

          if (backendUser) {
              completeAuth(backendUser, backendUser.name);
              return;
          }

          const res = await fetch('/api/storage?key=core_lms_users_v1');
          let users = await res.json().catch(() => []);
          const foundUserIndex = users.findIndex((u: any) => u.login === login.trim() && u.pass === pass.trim());
          if (foundUserIndex === -1) {
              setErrorMessage("Неправильно введен логин или пароль!");
              return;
          }
          const existingUser = users[foundUserIndex];
          users[foundUserIndex] = { ...existingUser, name: regName.trim() };
          saveDataToServer('core_lms_users_v1', users);
          completeAuth(existingUser, regName.trim());
      } catch (error) {
          setErrorMessage("Не удалось подключиться к базе данных для регистрации.");
      }
  };

  const handleLogout = () => {
    const keysToRemove = [
        'isLoggedIn', 'userRole', 'current_user_id', 'current_user_name', 
        'th_current_user', 'currentUser', 'user', 'profile', 'userData', 'account'
    ];
    
    keysToRemove.forEach(key => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    });

    deleteAppCookie('isLoggedIn');
    deleteAppCookie('userRole');
    deleteAppCookie('current_user_id');
    deleteAppCookie('current_user_name');

    window.dispatchEvent(new Event('storage'));

    setIsLoggedIn(false);
    setIsProfileOpen(false);
    router.push(withPreviewPath('/'));
  };

  const removeNotification = async (id: number) => {
    try {
        const res = await fetch('/api/storage?key=core_lms_notifications_v1');
        const allNotifs = await res.json().catch(() => []);
        
        if (Array.isArray(allNotifs)) {
            const updated = allNotifs.filter((n: any) => n.id !== id);
            saveDataToServer('core_lms_notifications_v1', updated);
            
            const currentUserId = localStorage.getItem('current_user_id') || sessionStorage.getItem('current_user_id') || 'guest';
            const myNotifs = updated.filter((n: any) => n.target === 'Все' || n.target === currentUserId || !n.target);
            setNotifications(myNotifs);
        }
    } catch (e) {
        console.error("Не удалось удалить уведомление:", e);
    }
  };

  const clearAllNotifications = async () => {
    try {
        const res = await fetch('/api/storage?key=core_lms_notifications_v1');
        const allNotifs = await res.json().catch(() => []);

        if (Array.isArray(allNotifs)) {
            const currentUserId = localStorage.getItem('current_user_id') || sessionStorage.getItem('current_user_id') || 'guest';
            
            const updated = allNotifs.filter((n: any) => {
                const isMyNotif = n.target === 'Все' || n.target === currentUserId || !n.target;
                return !isMyNotif; 
            });
            
            saveDataToServer('core_lms_notifications_v1', updated);
            setNotifications([]);
        }
    } catch (e) {
        console.error("Не удалось очистить уведомления:", e);
    }
  };

  const handleSearch = (val: string) => {
    setSearchQuery(val);
    if (!val.trim()) {
      setSearchResults([]);
      setIsSearchOpen(false);
      return;
    }

    const q = val.toLowerCase();
    const results: any[] = [];

    searchDbRoutes.forEach((route: any) => {
      const rText = [route.title, route.h1, route.t1, route.h2, route.t2, route.h3, route.t3].filter(Boolean).join(" ").toLowerCase();
      if (rText.includes(q)) {
        results.push({ id: `r_${route.id}`, title: route.title, subtitle: `Теория`, link: `/tasks?tab=edu&routeId=${route.id}` });
      }
    });

    searchDbTests.forEach((test: any) => {
      const tText = [test.title, test.subtitle, test.theory, ...(test.quiz ? test.quiz.map((qz:any) => qz.q) : [])].filter(Boolean).join(" ").toLowerCase();
      if (tText.includes(q)) {
        results.push({ id: `t_${test.id}`, title: test.title, subtitle: `Тестирование`, link: `/tasks?tab=edu&testId=${test.id}` });
      }
    });

    const searchAssortment = (nodes: any[]) => {
        nodes.forEach(node => {
            const aText = [node.title, node.desc, node.content].filter(Boolean).join(" ").toLowerCase();
            if (aText.includes(q)) {
                results.push({ id: `a_${node.id}`, title: node.title, subtitle: industryContent.assortmentLabel, link: `/tasks?tab=assortment&assortmentId=${node.id}` });
            }
            if (node.children) searchAssortment(node.children);
        });
    };
    searchAssortment(searchDbAssortment);

    setSearchResults(results.slice(0, 6)); 
    setIsSearchOpen(true);
  };

  const handleResultClick = (link: string) => {
    setIsSearchOpen(false);
    setSearchQuery('');
    if (window.innerWidth <= 768) setIsSidebarOpen(false);
    router.push(withPreviewPath(link));
  };

  const baseSideItems = [
    { 
      id: userRole === 'admin' ? '/admin' : '/tasks?tab=welcome', 
      label: userRole === 'admin' ? 'Меню управления' : 'Статистика',
      isSubItem: false 
    },
    { id: '/tasks?tab=edu', label: preview.enabled ? design.content.navTasksLabel : 'Обучение', isSubItem: false },
    { id: '/tasks?tab=docs', label: preview.enabled ? industryContent.documentsLabel : 'База документов', isSubItem: true },
    { id: '/tasks?tab=assortment', label: preview.enabled ? industryContent.assortmentLabel : 'Ассортимент', isSubItem: false },
    { id: '/tasks?tab=products', label: preview.enabled ? industryContent.productsLabel : 'Продукты', isSubItem: true },
    { id: '/tasks?tab=standards', label: preview.enabled ? industryContent.assistantLabel : 'ИИ Помощник', isSubItem: false },
  ];
  const sideItems = preview.enabled
    ? baseSideItems.filter((item) => {
        if (item.id === '/tasks?tab=docs') {
            return preview.features.documentTemplates;
        }

        if (item.id === '/tasks?tab=products') {
            return preview.features.branding || preview.features.advancedAnalytics;
        }

        if (item.id === '/tasks?tab=standards') {
            return preview.features.aiAssistant;
        }

        return true;
      })
    : baseSideItems;

  return (
    <>
      {!isLoggedIn ? (
        <header style={guestHeader} className="guest-header">
           <div onClick={() => setShowLoginModal(true)} style={loginBtn(buttonColor)}>{design.content.loginButtonLabel.toUpperCase()}</div>
        </header>
      ) : (
        <>
          {isSidebarOpen && <div className="sidebar-mobile-overlay" onClick={() => setIsSidebarOpen(false)}></div>}

          <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="sidebar-toggle-fixed"
              style={sidebarToggleStyle as any}
              aria-label="Переключить меню"
          >
              <MenuIcon />
          </button>

          <aside style={{ ...sidebarStyle, left: isSidebarOpen ? 0 : '-260px', transition: '0.3s ease' }} className="nav-sidebar">
             <div style={logoArea}>
                <span style={logoText}>{preview.enabled ? `${preview.brandName ?? 'Клиент'} • LMS` : 'Меню'}</span>
             </div>
             <nav style={sideNav}>
                {sideItems.map(item => {
                    const isActive = (pathname + (typeof window !== 'undefined' ? window.location.search : '')) === item.id;
                    return (
                        <Link 
                            key={item.id} 
                            href={withPreviewPath(item.id)} 
                            className={`nav-item ${isActive ? 'active' : ''} ${item.isSubItem ? 'sub-item' : ''}`}
                            onClick={() => { if (typeof window !== 'undefined' && window.innerWidth <= 768) setIsSidebarOpen(false); }}
                        >
                            {item.isSubItem && <span className="sub-item-arrow" aria-hidden="true">↳</span>}
                            <span>{item.label}</span>
                        </Link>
                    );
                })}
             </nav>
          </aside>

          <header style={{ ...topBarStyle, left: isSidebarOpen ? '260px' : '72px', transition: '0.3s ease' }} className="nav-topbar">
             <div style={searchBox} className="search-box-container">
                <span style={{ opacity: 0.5, display: 'flex', alignItems: 'center' }}><SearchIcon /></span>
                <input 
                  type="text" 
                  placeholder={preview.enabled ? "Поиск по preview LMS..." : "Поиск по базе знаний..."} 
                  style={searchInput} 
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  onFocus={() => searchQuery.trim() && setIsSearchOpen(true)}
                  onBlur={() => setTimeout(() => setIsSearchOpen(false), 200)}
                />

                {isSearchOpen && (
                  <div style={searchDropdownStyle as any}>
                    {searchResults.length > 0 ? (
                      searchResults.map(res => (
                      <div key={res.id} onMouseDown={() => handleResultClick(res.link)} className="search-result-item" style={searchResultItem as any}>
                        <div style={{ fontSize: '14px', fontWeight: '800', color: '#fff' }}>{res.title}</div>
                          <div style={{ fontSize: '11px', color: primary, fontWeight: '900', marginTop: '5px' }}>{res.subtitle}</div>
                        </div>
                      ))
                    ) : (
                      <div style={{ padding: '20px', textAlign: 'center', color: '#666', fontSize: '13px', fontWeight: 'bold' }}>Ничего не найдено</div>
                    )}
                  </div>
                )}
              </div>
             
             <div style={topActions} className="top-actions">
                {/* Заменен эмодзи колокольчика на векторный SVG */}
                {!preview.enabled ? (
                <div onClick={() => setIsNotifOpen(true)} className="top-icon-btn" style={topIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 22C13.1046 22 14 21.1046 14 20H10C10 21.1046 10.8954 22 12 22Z" fill="currentColor"/>
                      <path d="M18 16V11C18 7.93 16.36 5.36 13.5 4.68V4C13.5 3.17 12.83 2.5 12 2.5C11.17 2.5 10.5 3.17 10.5 4V4.68C7.64 5.36 6 7.92 6 11V16L4 18V19H20V18L18 16ZM16 17H8V11C8 8.52 9.51 6.5 12 6.5C14.49 6.5 16 8.52 16 11V17Z" fill="currentColor"/>
                  </svg>
                  {notifications.length > 0 && (
                    <div style={{ position: 'absolute', top: '-4px', right: '-4px', width: '12px', height: '12px', background: '#ff4d4d', borderRadius: '50%', border: '2px solid #111' }}></div>
                  )}
                </div>
                ) : (
                  <div style={{ color: primary, fontSize: '12px', fontWeight: '900', letterSpacing: '1px', textTransform: 'uppercase' }}>
                    Preview Mode
                  </div>
                )}
                
                {/* Заменен эмодзи профиля на векторный SVG */}
                <div onClick={() => setIsProfileOpen(!isProfileOpen)} className="top-icon-btn" style={profileTrigger}>
                   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                       <path d="M12 12C14.21 12 16 10.21 16 8C16 5.79 14.21 4 12 4C9.79 4 8 5.79 8 8C8 10.21 9.79 12 12 12ZM12 14C9.33 14 4 15.34 4 18V20H20V18C20 15.34 14.67 14 12 14Z" fill="currentColor"/>
                   </svg>
                   {isProfileOpen && (
                     <div style={profileDropdown}>
                        <Link href={withPreviewPath('/profile')} className="drop-item" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 12C14.21 12 16 10.21 16 8C16 5.79 14.21 4 12 4C9.79 4 8 5.79 8 8C8 10.21 9.79 12 12 12ZM12 14C9.33 14 4 15.34 4 18V20H20V18C20 15.34 14.67 14 12 14Z" fill="currentColor"/>
                            </svg>
                            Мой Профиль
                        </Link>
                        <div onClick={handleLogout} className="drop-item logout-item" style={{ borderBottom: 'none', paddingLeft: '20px' }}>Выйти</div>
                     </div>
                   )}
                </div>
             </div>
          </header>

          {isNotifOpen && (
            <div style={notifOverlayStyle as any} onClick={() => setIsNotifOpen(false)}>
              <div style={notifSidebarStyle as any} className="notif-sidebar-custom" onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', gap: '15px' }}>
                  <h2 style={{ fontSize: '20px', fontWeight: '900', color: '#fff', margin: 0 }}>УВЕДОМЛЕНИЯ</h2>
                  <div style={{ display: 'flex', gap: '15px', alignItems: 'center', marginLeft: 'auto' }}>
                      {notifications.length > 0 && (
                          <span onClick={clearAllNotifications} style={{ fontSize: '11px', color: '#ff4d4d', cursor: 'pointer', fontWeight: '900', textTransform: 'uppercase', borderBottom: '1px dashed #ff4d4d', transition: '0.2s', whiteSpace: 'nowrap' }}>Очистить всё</span>
                      )}
                      <div onClick={() => setIsNotifOpen(false)} style={{ cursor: 'pointer', fontSize: '20px', opacity: 0.5, flexShrink: 0 }}>X</div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  {notifications.length === 0 ? (
                     <div style={{ color: '#555', textAlign: 'center', marginTop: '40px', fontSize: '14px', fontWeight: 'bold' }}>Нет новых уведомлений</div>
                  ) : (
                     notifications.map(n => (
                      <div key={n.id} style={notifItemStyle as any}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '5px' }}>
                          <div style={{ fontSize: '14px', fontWeight: '900', color: '#0abab5' }}>{n.title}</div>
                          <div onClick={() => removeNotification(n.id)} style={{ cursor: 'pointer', fontSize: '16px', color: '#666', paddingLeft: '10px' }}>X</div>
                        </div>
                        <div style={{ fontSize: '13px', color: '#ccc', lineHeight: '1.4' }}>{n.text}</div>
                        <div style={{ fontSize: '10px', color: '#555', marginTop: '10px', fontWeight: 'bold' }}>{n.time}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* --- МОДАЛЬНОЕ ОКНО ОШИБКИ (ФИРМЕННОЕ) --- */}
      {errorMessage && (
          <div style={{...modalOverlay, zIndex: 40000} as any} onClick={() => setErrorMessage("")}>
              <div className="modal-content-custom" style={{
                  background: '#111',
                  padding: '40px 30px',
                  borderRadius: '30px',
                  width: '90%',
                  maxWidth: '380px',
                  border: '1px solid #333',
                  textAlign: 'center',
                  boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
                  boxSizing: 'border-box',
                  animation: 'scaleIn 0.2s ease'
              }} onClick={e => e.stopPropagation()}>
                  <div style={warningBadgeStyle as any}><CustomIcon name="alert" size={34} color="#ff4d4d" /></div>
                  <h2 style={{ color: '#ff4d4d', fontSize: '20px', fontWeight: '900', marginBottom: '15px', textTransform: 'uppercase' }}>Ошибка</h2>
                  <p style={{ color: '#ccc', fontSize: '14px', lineHeight: '1.5', marginBottom: '25px' }}>{errorMessage}</p>
                  <div onClick={() => setErrorMessage("")} style={{ width: '100%', padding: '14px', background: '#333', color: '#fff', borderRadius: '14px', fontWeight: '900', cursor: 'pointer', fontSize: '14px', textTransform: 'uppercase', transition: '0.2s' }}>ЗАКРЫТЬ</div>
              </div>
          </div>
      )}

      {/* --- МОДАЛЬНОЕ ОКНО ВХОДА И РЕГИСТРАЦИИ --- */}
      {showLoginModal && (
        <div style={modalOverlay}>
          <div className="modal-content-custom auth-modal" style={{ ...modalContent, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{color:'#fff', textAlign:'center', marginBottom:'25px', fontWeight: '900', letterSpacing: '1px', fontSize: '18px'}}>
                {isLoginMode ? design.content.loginTitle.toUpperCase() : 'АКТИВАЦИЯ АККАУНТА'}
            </h2>
            
            {!isLoginMode && (
                <input className="auth-field" type="text" placeholder="Ваше Имя (для профиля)" value={regName} onChange={(e)=>setRegName(e.target.value)} style={inputS} />
            )}
            
            {isLoginMode ? (
                <>
                    <input className="auth-field" type="text" placeholder="Логин" value={login} onChange={(e)=>setLogin(e.target.value)} style={inputS} />
                    <input className="auth-field" type="password" placeholder="Пароль" value={pass} onChange={(e)=>setPass(e.target.value)} style={inputS} onKeyDown={(e) => { if(e.key === 'Enter') { handleLogin() } }} />
                </>
            ) : (
                <div className="auth-inline-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', width: '100%' }}>
                    <input className="auth-field" type="text" placeholder="Логин" value={login} onChange={(e)=>setLogin(e.target.value)} style={{ ...inputS, marginBottom: 0 }} />
                    <input className="auth-field" type="password" placeholder="Пароль" value={pass} onChange={(e)=>setPass(e.target.value)} style={{ ...inputS, marginBottom: 0 }} onKeyDown={(e) => { if(e.key === 'Enter') { handleRegister() } }} />
                </div>
            )}
            
            {!isLoginMode && (
                <>
                    <input className="auth-field" type="email" placeholder="E-mail адрес" value={email} onChange={(e)=>setEmail(e.target.value)} style={inputS} />
                    <input className="auth-field" type="text" placeholder="Telegram (напр. @nik_name)" value={regTg} onChange={(e)=>setRegTg(e.target.value)} style={inputS} />
                    <input className="auth-field" type="text" placeholder="Номер телефона" value={regPhone} onChange={(e)=>setRegPhone(e.target.value)} style={inputS} />
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '5px', marginBottom: '20px', width: '100%' }}>
                        <div className="auth-consent-checkbox"
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
                        <div style={{ color: '#888', fontSize: '12px', lineHeight: '1.4', textAlign: 'left' }}>
                            Я даю согласие на <a href="/privacy?doc=processing#processing" style={{ color: '#0abab5', textDecoration: 'underline' }}>обработку персональных данных</a>
                        </div>
                    </div>
                </>
            )}

            {failedAttempts >= 3 && (
                <div style={{ display: 'flex', justifyContent: 'center', width: '100%', marginBottom: '15px', marginTop: '5px' }}>
                    <div className="tea-guard-container" style={teaGuardContainerStyle as any}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                            <div className="tea-guard-checkbox" onClick={handleCaptchaClick} style={teaGuardCheckboxStyle(isCaptchaVerified) as any}>
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
                <div onClick={handleLogin} style={modalLoginBtn}>{design.content.loginButtonLabel.toUpperCase()}</div>
            ) : (
                <div onClick={handleRegister} style={modalLoginBtn}>{design.content.registerButtonLabel.toUpperCase()}</div>
            )}
            
            <div 
                onClick={() => { 
                    setIsLoginMode(!isLoginMode); 
                    setFailedAttempts(0); 
                    setIsCaptchaVerified(false); 
                    setIsCaptchaLoading(false); 
                    setIsConsentGiven(false);
                }} 
                style={{...closeText, color: '#0abab5', marginTop: '15px', textDecoration: 'underline'}}
            >
                {isLoginMode ? design.content.registerButtonLabel : design.content.loginButtonLabel}
            </div>

            <div onClick={()=> { 
                setShowLoginModal(false); 
                setIsLoginMode(true); 
                setFailedAttempts(0); 
                setIsCaptchaVerified(false); 
                setIsCaptchaLoading(false); 
                setIsConsentGiven(false);
            }} style={closeText}>{design.content.cancelLabel.toUpperCase()}</div>
          </div>
        </div>
      )}
      
      <style jsx global>{`
         @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes scaleIn { 
          from { transform: scale(0.9); opacity: 0; } 
          to { transform: scale(1); opacity: 1; } 
        }
        @keyframes captchaSpin {
          100% { transform: rotate(360deg); }
        }
        .captcha-spinner {
          width: 18px;
          height: 18px;
          border: 3px solid #333;
          border-top-color: #0abab5;
          border-radius: 50%;
          animation: captchaSpin 1s linear infinite;
        }

        body {
            margin: 0;
            padding: 0;
            overflow-x: hidden !important;
        }
        * {
            box-sizing: border-box;
        }

        html::-webkit-scrollbar,
        body::-webkit-scrollbar {
            display: none;
            width: 0;
        }
        html, body {
            -ms-overflow-style: none;
            scrollbar-width: none;
        }

        .custom-scroll::-webkit-scrollbar {
            display: none;
        }
        .custom-scroll {
            -ms-overflow-style: none;
            scrollbar-width: none;
        }

        .nav-item {
            display: flex;
            align-items: center;
            gap: 15px;
            color: #555;
            text-decoration: none;
            padding: 16px;
            border-radius: 18px;
            background: transparent;
            font-weight: 800;
            font-size: 15px;
            
            /* Фикс прыгающих шрифтов при масштабировании и анимациях */
            transition: transform 0.2s ease, color 0.2s ease, background-color 0.2s ease, opacity 0.2s ease;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            backface-visibility: hidden;
            transform: translateZ(0);
            will-change: transform, color, background-color;
            
            cursor: pointer;
        }
        
        /* СТИЛИ ДЛЯ ПОДПУНКТОВ МЕНЮ */
        .nav-item.sub-item {
            font-size: 13px;
            padding: 10px 16px 10px 30px;
            margin-top: -5px;
            margin-bottom: 5px;
            opacity: 0.7;
            font-weight: 700;
        }
        .sub-item-arrow {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 14px;
            margin-right: 8px;
            color: rgba(255, 255, 255, 0.52);
            font-size: 14px;
            line-height: 1;
            transition: color 0.2s ease, transform 0.2s ease;
        }
        .nav-item.sub-item:hover {
            opacity: 1;
            color: #0abab5;
            background: transparent;
            transform: translateX(4px) translateZ(0);
        }
        .nav-item.sub-item:hover .sub-item-arrow {
            color: #0abab5;
            transform: translateX(1px);
        }
        .nav-item.sub-item.active {
            color: #0abab5;
            background: rgba(10, 186, 181, 0.1);
            opacity: 1;
            transform: translateX(0) translateZ(0);
        }
        .nav-item.sub-item.active .sub-item-arrow {
            color: #0abab5;
        }

        .nav-item.active:not(.sub-item) {
            color: #fff;
            background: #111;
        }
        .nav-item:not(.sub-item):hover {
            color: #0abab5;
            background: rgba(10, 186, 181, 0.05);
            transform: translateX(6px) translateZ(0);
        }
        .nav-item:not(.sub-item):active {
            transform: scale(0.96) translateX(0) translateZ(0);
            background: rgba(10, 186, 181, 0.15);
        }

        .drop-item {
            display: block;
            padding: 20px;
            color: #fff;
            text-decoration: none;
            font-size: 14px;
            font-weight: 700;
            border-bottom: 1px solid #1a1a1a;
            transition: 0.2s ease;
            cursor: pointer;
        }
        .drop-item:hover {
            background: #1a1a1a;
            color: #0abab5;
            padding-left: 28px;
        }

        .logout-item:hover {
            color: #ff4d4d !important;
            background: rgba(255, 77, 77, 0.1) !important;
        }
        
        .search-result-item:hover {
            background: rgba(10, 186, 181, 0.1);
        }

        /* Новые стили для кнопок в хедере */
        .top-icon-btn:hover {
            color: #fff !important;
            transform: scale(1.1);
        }

        .sidebar-mobile-overlay { display: none; }
        .sidebar-toggle-fixed {
            position: fixed;
            top: 22px;
            left: 30px;
            z-index: 10006;
            width: 36px;
            height: 36px;
            border: 1px solid #222;
            border-radius: 10px;
            background: #111;
            color: #fff;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            padding: 0;
            box-shadow: none;
            transition: top 0.3s ease, left 0.3s ease, transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
        }

        .sidebar-toggle-fixed:hover {
            border-color: #0abab5;
            box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(10, 186, 181, 0.45), 0 0 14px rgba(10, 186, 181, 0.55), 0 0 28px rgba(10, 186, 181, 0.28);
            transform: translateY(1px) scale(0.97);
            background: rgba(10, 186, 181, 0.12);
        }

        .sidebar-toggle-fixed:active {
            transform: translateY(2px) scale(0.95);
            box-shadow: inset 0 3px 8px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(10, 186, 181, 0.52), 0 0 16px rgba(10, 186, 181, 0.62), 0 0 32px rgba(10, 186, 181, 0.32);
        }

        @media (max-width: 768px) {
            .nav-topbar {
                left: 0 !important;
                padding: 0 10px 0 72px !important;
                height: 70px !important;
            }
            .nav-sidebar {
                z-index: 10005 !important;
            }
            .sidebar-toggle-fixed {
                top: 16px !important;
                left: 16px !important;
                width: 40px !important;
                height: 40px !important;
                border-radius: 12px !important;
            }
            .sidebar-mobile-overlay {
                display: block !important;
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.6);
                z-index: 10004;
                backdrop-filter: blur(5px);
            }

            .search-box-container {
                width: 100% !important;
                max-width: 100% !important;
                padding: 8px 12px !important;
                margin-right: 0 !important;
                flex: 1 !important;
                min-width: 50px !important;
            }
            .search-box-container input {
                min-width: 0 !important;
                text-overflow: ellipsis !important;
            }

            .guest-header {
                right: 15px !important;
                top: 15px !important;
            }
            
            .top-actions {
                gap: 15px !important;
            }

            .modal-content-custom {
                padding: 30px 20px !important;
                width: 95% !important;
            }

            .notif-sidebar-custom {
                width: 100% !important;
                border-left: none !important;
            }
        }

        @media (max-width: 640px) {
            .auth-inline-row {
                grid-template-columns: 1fr !important;
            }
        }
      `}</style>
    </>
  );
}

function MenuIcon() {
    return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 7H20M4 12H20M4 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function SearchIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
            <path d="M10.5 18C14.6421 18 18 14.6421 18 10.5C18 6.35786 14.6421 3 10.5 3C6.35786 3 3 6.35786 3 10.5C3 14.6421 6.35786 18 10.5 18Z" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

// --- СТИЛИ ---
const guestHeader: any = { position: 'fixed', top: '20px', right: '40px', zIndex: 1000 };
const loginBtn = (color: string): React.CSSProperties => ({ background: color, color: '#000', padding: '12px 35px', borderRadius: '15px', fontWeight: '900', cursor: 'pointer', fontSize:'14px' });

const sidebarStyle: any = { width: '260px', height: '100vh', background: '#000', position: 'fixed', left: 0, top: 0, padding: '22px 20px 40px 20px', display: 'flex', flexDirection: 'column', zIndex: 1001, borderRight: '1px solid #1a1a1a', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif' };
const logoArea: any = { display: 'flex', alignItems: 'center', minHeight: '36px', gap: '15px', color: '#fff', marginBottom: '50px', paddingLeft: '58px' };
const logoIcon: any = { fontSize: '24px', cursor: 'pointer' };
const warningBadgeStyle: any = { width: '60px', height: '60px', borderRadius: '18px', border: '1px solid rgba(255,77,77,0.35)', background: 'rgba(255,77,77,0.08)', color: '#ff4d4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '32px', fontWeight: '900', margin: '0 auto 15px auto' };
const logoText: any = { fontSize: '20px', fontWeight: '900', letterSpacing: '1px', color: '#fff' };
const sideNav: any = { display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 };

const topBarStyle: any = { position: 'fixed', top: 0, right: 0, height: '90px', background: 'rgba(13, 15, 13, 0.8)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 50px', zIndex: 1000, boxSizing: 'border-box' };
const searchBox: any = { position: 'relative', background: '#111', padding: '12px 25px', borderRadius: '18px', display: 'flex', alignItems: 'center', gap: '15px', width: '450px', maxWidth: '40vw', border: '1px solid #222', boxSizing: 'border-box' };
const searchInput: any = { background: 'none', border: 'none', color: '#fff', outline: 'none', width: '100%', fontSize: '16px', fontWeight: '500' };
const searchDropdownStyle: any = { position: 'absolute', top: '55px', left: 0, width: '100%', background: '#111', border: '1px solid #222', borderRadius: '18px', overflow: 'hidden', boxShadow: '0 20px 50px rgba(0,0,0,0.8)', zIndex: 10005, display: 'flex', flexDirection: 'column' };
const searchResultItem: any = { padding: '16px 20px', borderBottom: '1px solid #1a1a1a', cursor: 'pointer', transition: '0.2s' };
const topActions: any = { display: 'flex', alignItems: 'center', gap: '30px' };
const topIcon: any = { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ccc', cursor: 'pointer', transition: '0.3s' };
const sidebarToggleStyle: React.CSSProperties = { width: '36px', height: '36px', border: '1px solid #222', borderRadius: '10px', background: '#111', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, flexShrink: 0 };
const profileTrigger: any = { width: '48px', height: '48px', background: '#111', border: '1px solid #222', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative', color: '#888', transition: '0.3s' };
const profileDropdown: any = { position: 'absolute', top: '65px', right: 0, background: '#111', border: '1px solid #222', borderRadius: '20px', width: '220px', overflow: 'hidden', boxShadow: '0 20px 50px rgba(0,0,0,0.7)', zIndex: 10003 };
const notifOverlayStyle = { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.4)', zIndex: 20000, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'auto' };
const notifSidebarStyle = { width: '350px', height: '100%', background: '#000', borderLeft: '1px solid #222', padding: '40px 30px', animation: 'slideInRight 0.4s ease', boxShadow: '-20px 0 50px rgba(0,0,0,0.5)', overflowY: 'auto' };
const notifItemStyle = { background: '#0d0d0d', padding: '20px', borderRadius: '18px', border: '1px solid #1a1a1a', marginBottom: '10px' };
const modalOverlay: any = { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30000, backdropFilter: 'blur(15px)', boxSizing: 'border-box', pointerEvents: 'auto' };

const modalContent: any = { 
    background: '#000', 
    padding: '40px 35px', 
    borderRadius: '35px', 
    width: '90%', 
    maxWidth: '440px', 
    maxHeight: '95vh', 
    overflowY: 'auto',
    border: '1px solid #222', 
    display: 'flex', 
    flexDirection: 'column', 
    alignItems: 'center', 
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)', 
    boxSizing: 'border-box',
    className: 'custom-scroll' 
};

const teaGuardContainerStyle = {
    background: '#161816',
    border: '1px solid #333',
    borderRadius: '12px',
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

const inputS: any = { 
    width: '100%', 
    padding: '14px 20px', 
    marginBottom: '12px', 
    borderRadius: '14px', 
    background: '#0d0d0d', 
    border: '1px solid #222', 
    color: '#fff', 
    outline: 'none', 
    fontSize: '16px', 
    textAlign: 'center', 
    boxSizing: 'border-box' 
};

const modalLoginBtn: any = { 
    width: '100%', 
    padding: '14px', 
    background: '#0ABAB5', 
    color: '#000', 
    textAlign: 'center', 
    borderRadius: '14px', 
    fontWeight: '900', 
    cursor: 'pointer', 
    fontSize: '15px', 
    textTransform: 'uppercase', 
    marginTop: '15px', 
    boxSizing: 'border-box' 
};

const closeText: any = { 
    color: '#444', 
    textAlign: 'center', 
    marginTop: '20px', 
    cursor: 'pointer', 
    fontSize: '12px', 
    fontWeight: '800', 
    textTransform: 'uppercase' 
};
