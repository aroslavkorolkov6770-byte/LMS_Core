"use client";
import React, { useState, useEffect, Suspense } from 'react';
import Navigation from '@/app/components/Navigation';
import CustomIcon from '@/app/components/CustomIcon';
import { getPreviewElementStyle } from '@/app/lib/preview-element-style';
import { usePreviewRuntime } from '@/app/lib/use-preview-runtime';
import { appendPreviewParams } from '@/app/lib/preview-runtime';
import { useRouter, useSearchParams } from 'next/navigation';

// --- ХЕЛПЕР ДЛЯ ЗАПИСИ ДАННЫХ НА СЕРВЕР ---
const saveDataToServer = (key: string, data: any) => {
    fetch('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, data })
    }).catch(err => console.error("Ошибка сохранения на server:", err));
};

function ProfileContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const preview = usePreviewRuntime(searchParams);
    const design = preview.design;
    const [isMounted, setIsMounted] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(!preview.enabled);
    const [isEditing, setIsEditing] = useState(false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    
    // Стейты для модального окна авторизации (Логин + Пароль)
    const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
    const [newLogin, setNewLogin] = useState('');
    const [newPass, setNewPass] = useState('');
    
    const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
    const [helpTab, setHelpTab] = useState<'ios' | 'android' | 'desktop' | 'email'>('ios');
    
    const [userRole, setUserRole] = useState('staff');
    const [userId, setUserId] = useState('guest');
    
    // Стейты для кнопки PUSH-уведомлений
    const [pushBtnText, setPushBtnText] = useState('ПОДКЛЮЧИТЬ УВЕДОМЛЕНИЯ');
    const [pushBtnColor, setPushBtnColor] = useState('#0abab5');
    
    const [profile, setProfile] = useState({
        name: '',
        avatar: '',
        tg: '',
        phone: '',
        email: ''
    });

    const [progress, setProgress] = useState({
        routeCount: 0,
        totalRoute: 5
    });

    useEffect(() => {
        const handleSidebarState = (event: Event) => {
            const customEvent = event as CustomEvent<{ open?: boolean }>;
            setIsSidebarOpen(customEvent.detail?.open === true);
        };

        window.addEventListener('sidebarStateChange', handleSidebarState);

        return () => window.removeEventListener('sidebarStateChange', handleSidebarState);
    }, []);

    useEffect(() => {
        const loadProfileData = async () => {
            const role = localStorage.getItem('userRole') || 'staff';
            const currentId = localStorage.getItem('current_user_id') || 'guest';
            const currentName = localStorage.getItem('current_user_name') || (role === 'admin' ? 'Главный Мастер' : 'Сотрудник');
            
            setUserRole(role);
            setUserId(currentId);

            try {
                // Подгружаем личные данные профиля
                let pData = await fetch(`/api/storage?key=profile_data_${currentId}`).then(r => r.json()).catch(() => null);
                if (!pData || Array.isArray(pData) || Object.keys(pData).length === 0) {
                    pData = { avatar: '', tg: role === 'admin' ? 'admin_tea' : 'username', phone: '', email: '', firstLogin: new Date().toISOString() };
                    saveDataToServer(`profile_data_${currentId}`, pData);
                }

                setProfile({
                    name: currentName,
                    avatar: pData.avatar || '',
                    tg: pData.tg || '',
                    phone: pData.phone || '',
                    email: pData.email || '' 
                });

                // Загружаем статистику только для сотрудников
                if (role !== 'admin') {
                    const routeData = await fetch(`/api/storage?key=prog_route_${currentId}`).then(r => r.json()).catch(() => []);
                    const rDb = await fetch(`/api/storage?key=core_lms_route_v1`).then(r => r.json()).catch(() => []);
                    const rTotal = Array.isArray(rDb) && rDb.length > 0 ? rDb.length : 5;

                    setProgress({
                        routeCount: Array.isArray(routeData) ? routeData.length : 0,
                        totalRoute: rTotal
                    });
                }

                // Проверка подписки на Push
                if ('serviceWorker' in navigator && 'PushManager' in window) {
                    const registration = await navigator.serviceWorker.getRegistration();
                    if (registration) {
                        const sub = await registration.pushManager.getSubscription();
                        if (sub) {
                            setPushBtnText('ПЕРЕПРИВЯЗАТЬ УСТРОЙСТВО');
                            setPushBtnColor('#4CAF50');
                        }
                    }
                }

                setIsMounted(true);
            } catch (error) {
                console.error("Ошибка загрузки профиля:", error);
                setIsMounted(true); 
            }
        };

        loadProfileData();
    }, []);

    const handleSubscribeToPush = async () => {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            alert("Ваш браузер не поддерживает Web Push уведомления. Попробуйте Google Chrome.");
            return;
        }
        
        if (userId === 'guest' || !userId) {
            alert("Перед включением уведомлений нужно войти в аккаунт!");
            return;
        }

        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                alert(" Вы заблокировали уведомления в браузере. Разрешите их в настройках сайта.");
                return;
            }

            const swUrl = `/sw.js?v=${Date.now()}`;
            const registration = await navigator.serviceWorker.register(swUrl);
            let subscription = await registration.pushManager.getSubscription();

            if (subscription) {
                await subscription.unsubscribe();
            }

            const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
            if (!vapidPublicKey) {
                alert(" Ошибка: VAPID ключ не найден в .env");
                return;
            }

            const urlBase64ToUint8Array = (base64String: string) => {
                const cleanKey = base64String.replace(/["']/g, '').trim();
                const padding = '='.repeat((4 - cleanKey.length % 4) % 4);
                const base64 = (cleanKey + padding).replace(/\-/g, '+').replace(/_/g, '/');
                const rawData = window.atob(base64);
                const outputArray = new Uint8Array(rawData.length);
                for (let i = 0; i < rawData.length; ++i) {
                    outputArray[i] = rawData.charCodeAt(i);
                }
                return outputArray;
            };

            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
            });

            const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_push_subscriptions_v1`);
            let subs = await res.json().catch(() => []);
            if (!Array.isArray(subs)) subs = [];

            subs = subs.filter((s: any) => s.sub.endpoint !== subscription?.endpoint);
            
            subs.push({ userId: userId, sub: subscription });
            await saveDataToServer('core_lms_push_subscriptions_v1', subs);
            
            setPushBtnText('ПЕРЕПРИВЯЗАТЬ УСТРОЙСТВО');
            setPushBtnColor('#4CAF50');
            alert("Устройство успешно привязано к вашему аккаунту!");

        } catch (error: any) {
            console.error('Ошибка подписки на Push:', error);
            alert("Критическая ошибка: " + error.message);
        }
    };

    const handleOpenEdit = () => {
        setIsMenuOpen(false);
        setIsEditing(true);
    };

    // Открытие окна изменения данных авторизации с автоматической подгрузкой текущих логина и пароля
    const handleOpenAuthChange = async () => {
        setIsMenuOpen(false);
        try {
            const users = await fetch('/api/storage?key=core_lms_users_v1').then(r => r.json()).catch(() => []);
            if (Array.isArray(users)) {
                const myUser = users.find((u:any) => u.id === userId);
                if (myUser) {
                    setNewLogin(myUser.login || '');
                    setNewPass(myUser.pass || '');
                }
            }
        } catch (e) {
            console.error(e);
        }
        setIsAuthModalOpen(true);
    };

    const handleLogout = () => {
        localStorage.clear();
        router.push(appendPreviewParams('/', searchParams));
    };

    const handleSaveProfile = async () => {
        localStorage.setItem('current_user_name', profile.name);
        
        try {
            let pData = await fetch(`/api/storage?key=profile_data_${userId}`).then(r => r.json()).catch(() => ({}));
            if (Array.isArray(pData)) pData = {};
            
            pData.avatar = profile.avatar;
            pData.tg = profile.tg;
            pData.phone = profile.phone;
            pData.email = profile.email;
            
            saveDataToServer(`profile_data_${userId}`, pData);

            const users = await fetch('/api/storage?key=core_lms_users_v1').then(r => r.json()).catch(() => []);
            if (Array.isArray(users)) {
                const updatedUsers = users.map((u:any) => u.id === userId ? { ...u, name: profile.name } : u);
                saveDataToServer('core_lms_users_v1', updatedUsers);
            }
        } catch (error) {
            console.error("Ошибка сохранения профиля:", error);
        }

        setIsEditing(false);
    };

    // Сохранение только пароля из модального окна
    const handleChangeAuth = async () => {
        if (!newPass.trim()) {
            alert("Пароль не может быть пустым!");
            return;
        }
        
        try {
            const users = await fetch('/api/storage?key=core_lms_users_v1').then(r => r.json()).catch(() => []);
            
            if (Array.isArray(users)) {
                // Обновляем только пароль для текущего пользователя
                const updatedUsers = users.map((u:any) => u.id === userId ? { ...u, pass: newPass.trim() } : u);
                saveDataToServer('core_lms_users_v1', updatedUsers);
                
                alert("Пароль успешно обновлен!");
                setIsAuthModalOpen(false);
            }
        } catch (error) {
            console.error("Ошибка смены данных авторизации:", error);
            alert("Не удалось сохранить новые данные.");
        }
    };

    const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            if (event.target?.result) {
                setProfile(prev => ({ ...prev, avatar: event.target!.result as string }));
            }
        };
        reader.readAsDataURL(file);
    };

    if (!isMounted) return <div style={{ backgroundColor: '#0d0f0d', minHeight: '100vh' }} />;

    return (
        <div className="lms-profile-page" style={{ backgroundColor: preview.enabled ? design.theme.background : '#0d0f0d', minHeight: '100vh', color: preview.enabled ? design.theme.text : '#fff', display: 'flex', overflowX: 'hidden' }}>
            <Navigation />
            
            <div style={{ width: isSidebarOpen ? '260px' : '0', transition: '0.3s', flexShrink: 0 }} className="sidebar-spacer" />

            <main style={{ flex: 1, padding: '120px 20px 140px 20px', maxWidth: '100%', boxSizing: 'border-box' }}>
                <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                    <section
                        data-preview-editable="profile.card"
                        data-preview-label="Карточка профиля"
                        data-preview-tab="layout"
                        style={getPreviewElementStyle(design, "profile.card", profileHeaderCardStyle)}
                    >
                        
                        {/* Прозрачный фон для закрытия меню шестерёнки по клику вне его */}
                        {isMenuOpen && (
                            <div onClick={() => setIsMenuOpen(false)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 90 }} />
                        )}

                        {/* Кнопка настроек (Шестерёнка) */}
                        <div onClick={() => setIsMenuOpen(!isMenuOpen)} style={settingsBtnStyle} className="settings-btn">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                        </div>

                        {isMenuOpen && (
                            <div style={contextMenuStyle}>
                                <div onClick={handleOpenEdit} style={menuItemStyle}>Настроить данные</div>
                                <div onClick={handleOpenAuthChange} style={menuItemStyle}>Сменить пароль</div>
                                <div onClick={handleLogout} style={{ ...menuItemStyle, color: '#ff7675', borderBottom: 'none' }}>Выйти из аккаунта</div>
                            </div>
                        )}

                        <div className="profile-avatar-frame" style={{ width: '130px', height: '130px', borderRadius: '45px', backgroundColor: '#000', margin: '0 auto 25px', border: '2px solid #4CAF50', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 15px 35px rgba(76, 175, 80, 0.2)' }}>
                            {profile.avatar ? (
                                <img src={profile.avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="Profile" />
                            ) : (
                                <span style={avatarFallbackText as any}><CustomIcon name={userRole === 'admin' ? 'lantern' : 'user'} size={42} color="#0abab5" /></span>
                            )}
                        </div>

                        <h2
                            data-preview-editable="profile.name"
                            data-preview-label="Имя профиля"
                            data-preview-tab="content"
                            style={getPreviewElementStyle(design, "profile.name", { fontSize: '32px', fontWeight: '900', margin: '0 0 8px 0', color: '#fff' })}
                        >
                            {profile.name}
                        </h2>
                        <p style={{ color: '#0abab5', fontWeight: 'bold', fontSize: '13px', margin: 0, letterSpacing: '2px', textTransform: 'uppercase' }}>
                            {userRole === 'admin' ? 'ГЛАВНЫЙ МАСТЕР (ADMIN)' : 'ЧАЙНЫЙ МАСТЕР (УЧЕНИК)'}
                        </p>
                    </section>

                    {/* Блок статистики обучения показывается только для сотрудников */}
                    {userRole !== 'admin' && (
                        <div style={{ animation: 'fadeInUp 0.5s ease' }}>
                            <section className="profile-progress-card" style={progressSectionStyle}>
                                <div>
                                    <div style={labelRow}><span style={{color:'#888'}}>ПЛАН НА НЕДЕЛЮ</span><span style={{color:'#0abab5'}}>{progress.routeCount}/{progress.totalRoute}</span></div>
                                    <div style={barBg}><div style={{ ...barFill, width: `${Math.min((progress.routeCount / (progress.totalRoute || 1)) * 100, 100)}%` }} /></div>
                                </div>
                            </section>
                        </div>
                    )}

                    <h3 style={sectionTitle}>СВЯЗЬ</h3>
                    <section className="profile-contact-card" style={contactCardStyle}>
                        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                            <div style={contactIconStyle}><CustomIcon name="chat" size={22} color="#0abab5" /></div>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '16px', fontWeight: '900', color: '#fff', marginBottom: '4px' }}>{profile.tg || 'Telegram не указан'}</div>
                                <div style={{ fontSize: '14px', color: '#0abab5', fontWeight: 'bold', marginBottom: '2px' }}>{profile.email || 'E-mail не указан'}</div>
                                <div style={{ fontSize: '13px', color: '#555' }}>{profile.phone || 'Телефон не указан'}</div>
                            </div>
                        </div>
                    </section>

                    <button 
                        onClick={handleSubscribeToPush} 
                        style={{
                            width: '100%',
                            padding: '20px',
                            marginTop: '30px',
                            background: `rgba(${pushBtnColor === '#4CAF50' ? '76, 175, 80' : '10, 186, 181'}, 0.1)`,
                            border: `1px solid ${pushBtnColor}`,
                            color: pushBtnColor,
                            borderRadius: '25px',
                            fontWeight: '900',
                            cursor: 'pointer',
                            fontSize: '14px',
                            transition: '0.3s',
                            letterSpacing: '1px'
                        }}
                    >
                        {pushBtnText}
                    </button>

                    <button 
                        onClick={() => setIsHelpModalOpen(true)} 
                        style={notificationHelpBtnStyle as any}
                    >
                        ИНСТРУКЦИЯ: НАСТРОЙКА УВЕДОМЛЕНИЙ
                    </button>
                </div>

                {/* МОДАЛЬНОЕ ОКНО: РЕДАКТОР ПРОФИЛЯ */}
                {isEditing && (
                    <div style={overlayStyle} onClick={() => setIsEditing(false)}>
                        <div className="profile-editor-modal" style={modalStyle} onClick={e => e.stopPropagation()}>
                            <h2 style={{ marginBottom: '30px', textAlign: 'center', fontWeight: '900', letterSpacing: '1px' }}>РЕДАКТОР ПРОФИЛЯ</h2>
                            <div style={{display:'flex', flexDirection:'column', gap:'15px'}}>
                                <input value={profile.name} onChange={e => setProfile({...profile, name: e.target.value})} placeholder="Ваше имя" style={inputItemStyle} />
                                
                                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                    <input type="file" id="avatar-upload" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarUpload} />
                                    <input value={profile.avatar} onChange={e => setProfile({...profile, avatar: e.target.value})} placeholder="Ссылка на фото (URL)" style={{ ...inputItemStyle, flex: 1, marginBottom: 0 }} />
                                    <button className="profile-upload-button" onClick={() => document.getElementById('avatar-upload')?.click()} style={{ background: '#222', color: '#0abab5', border: '1px solid #333', padding: '0 20px', height: '58px', borderRadius: '18px', cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>ЗАГРУЗИТЬ</button>
                                </div>

                                <input value={profile.tg} onChange={e => setProfile({...profile, tg: e.target.value})} placeholder="Telegram (напр. @nik_name)" style={inputItemStyle} />
                                <input value={profile.email} onChange={e => setProfile({...profile, email: e.target.value})} placeholder="E-mail адрес" style={inputItemStyle} />
                                <input value={profile.phone} onChange={e => setProfile({...profile, phone: e.target.value})} placeholder="Номер телефона" style={inputItemStyle} />
                            </div>
                            <button onClick={handleSaveProfile} style={saveButtonStyle}>СОХРАНИТЬ ИЗМЕНЕНИЯ</button>
                            <div onClick={() => setIsEditing(false)} style={cancelButtonStyle}>ОТМЕНА</div>
                        </div>
                    </div>
                )}

                {/* МОДАЛЬНОЕ ОКНО: СМЕНА ПАРОЛЯ */}
                {isAuthModalOpen && (
                    <div style={overlayStyle} onClick={() => setIsAuthModalOpen(false)}>
                        <div className="profile-editor-modal" style={modalStyle} onClick={e => e.stopPropagation()}>
                            <h2 style={{ marginBottom: '30px', textAlign: 'center', fontWeight: '900', letterSpacing: '1px', color: '#fff' }}>СМЕНА ПАРОЛЯ</h2>
                            <div style={{display:'flex', flexDirection:'column', gap:'15px'}}>
                                <div>
                                    <div style={{fontSize: '12px', color: '#888', fontWeight: 'bold', marginLeft: '5px', marginBottom: '5px'}}>Ваш логин (изменить нельзя):</div>
                                    <div style={{ ...inputItemStyle, background: '#111', color: '#888', borderColor: '#333' } as any}>{newLogin}</div>
                                </div>
                                
                                <div>
                                    <div style={{fontSize: '12px', color: '#888', fontWeight: 'bold', marginLeft: '5px', marginBottom: '5px'}}>Новый пароль доступа:</div>
                                    <input type="text" value={newPass} onChange={e => setNewPass(e.target.value)} placeholder="Введите новый пароль" style={inputItemStyle} />
                                </div>
                            </div>
                            <button onClick={handleChangeAuth} style={saveButtonStyle}>СОХРАНИТЬ ПАРОЛЬ</button>
                            <div onClick={() => setIsAuthModalOpen(false)} style={cancelButtonStyle}>ОТМЕНА</div>
                        </div>
                    </div>
                )}

                {/* МОДАЛЬНОЕ ОКНО: ИНСТРУКЦИЯ */}
                {isHelpModalOpen && (
                    <div style={overlayStyle} onClick={() => setIsHelpModalOpen(false)}>
                        <div className="custom-scroll" style={{...modalStyle, maxWidth: '700px', maxHeight: '90vh', overflowY: 'auto'}} onClick={e => e.stopPropagation()}>
                            
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
                                <h2 style={{ margin: 0, fontWeight: '900', color: '#fff', fontSize: '24px' }}>НАСТРОЙКА УВЕДОМЛЕНИЙ</h2>
                                <div onClick={() => setIsHelpModalOpen(false)} style={{ cursor: 'pointer', fontSize: '24px', color: '#ff4d4d', fontWeight: 'bold' }}>X</div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', background: '#000', borderRadius: '15px', padding: '4px', marginBottom: '30px', border: '1px solid #222' }}>
                                <div onClick={() => setHelpTab('ios')} style={tabStyle(helpTab === 'ios') as any}>iOS</div>
                                <div onClick={() => setHelpTab('android')} style={tabStyle(helpTab === 'android') as any}>Android</div>
                                <div onClick={() => setHelpTab('desktop')} style={tabStyle(helpTab === 'desktop') as any}>ПК</div>
                                <div onClick={() => setHelpTab('email')} style={tabStyle(helpTab === 'email') as any}>Почта</div>
                            </div>

                            {helpTab === 'ios' && (
                                <div style={{ animation: 'fadeIn 0.3s ease' }}>
                                    <p style={helpDescStyle as any}>Операционная система iOS разрешает получать Push-уведомления с платформ <b>только в случае установки сайта на домашний экран устройства</b>.</p>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>1</div><div style={stepTextStyle as any}>Откройте платформу Tea Hub строго в Safari.</div></div>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>2</div><div style={stepTextStyle as any}>Нажмите кнопку <b>«Поделиться»</b>.</div></div>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>3</div><div style={stepTextStyle as any}>Выберите пункт <b>«На экран "Домой"»</b>.</div></div>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>4</div><div style={stepTextStyle as any}>Запустите приложение через иконку на рабочем столе.</div></div>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>5</div><div style={stepTextStyle as any}>В профиле нажмите кнопку <b>«ПОДКЛЮЧИТЬ УВЕДОМЛЕНИЯ»</b>.</div></div>
                                </div>
                            )}

                            {helpTab === 'android' && (
                                <div style={{ animation: 'fadeIn 0.3s ease' }}>
                                    <p style={helpDescStyle as any}>Рекомендуется использовать браузер <b>Google Chrome</b>.</p>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>1</div><div style={stepTextStyle as any}>Зайдите в Tea Hub через Google Chrome.</div></div>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>2</div><div style={stepTextStyle as any}>В профиле нажмите кнопку <b>«ПОДКЛЮЧИТЬ УВЕДОМЛЕНИЯ»</b>.</div></div>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>3</div><div style={stepTextStyle as any}>Выберите <b>«Разрешить»</b>.</div></div>
                                </div>
                            )}

                            {helpTab === 'desktop' && (
                                <div style={{ animation: 'fadeIn 0.3s ease' }}>
                                    <p style={helpDescStyle as any}>Активация уведомлений на ПК.</p>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>1</div><div style={stepTextStyle as any}>В разделе Профиль нажмите кнопку <b>«ПОДКЛЮЧИТЬ УВЕДОМЛЕНИЯ»</b>.</div></div>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>2</div><div style={stepTextStyle as any}>В окне браузера подтвердите действие, нажав <b>«Разрешить»</b>.</div></div>
                                </div>
                            )}

                            {helpTab === 'email' && (
                                <div style={{ animation: 'fadeIn 0.3s ease' }}>
                                    <p style={helpDescStyle as any}>Настройка дублирования уведомлений на почту.</p>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>1</div><div style={stepTextStyle as any}>Убедитесь, что в профиле заполнен ваш E-mail.</div></div>
                                    <div style={stepCardStyle as any}><div style={stepNumStyle as any}>2</div><div style={stepTextStyle as any}>При получении писем проверьте папку «Спам» и нажмите кнопку <b>«Это не спам»</b>.</div></div>
                                </div>
                            )}

                            <button onClick={() => setIsHelpModalOpen(false)} style={{ ...saveButtonStyle, marginTop: '35px' } as any}>ПОНЯТНО, ЗАКРЫТЬ</button>
                        </div>
                    </div>
                )}
            </main>

            <style jsx global>{` 
                @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } } 
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                ::-webkit-scrollbar { width: 6px; height: 6px; }
                ::-webkit-scrollbar-thumb { background: #222; border-radius: 10px; }
                ::-webkit-scrollbar-track { background: transparent; }
                body { overflow-x: hidden; width: 100vw; }
                @media (max-width: 768px) { .sidebar-spacer { display: none; } }
                
                .settings-btn:hover {
                    background: #222 !important;
                    border-color: #0abab5 !important;
                    color: #0abab5 !important;
                }
            `}</style>
        </div>
    );
}

// --- СТИЛИ ---

const profileHeaderCardStyle: any = { 
    position: 'relative',
    backgroundColor: '#161816', 
    padding: '40px 30px', 
    borderRadius: '40px', 
    border: '1px solid #222', 
    textAlign: 'center', 
    marginBottom: '40px',
    boxShadow: '0 20px 50px rgba(0,0,0,0.3)'
};

const settingsBtnStyle: any = { 
    position: 'absolute', 
    top: '25px', 
    right: '25px', 
    width: '45px',
    height: '45px',
    background: '#111',
    border: '1px solid #333',
    borderRadius: '14px',
    color: '#aaa',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer', 
    transition: '0.2s',
    zIndex: 95
};

const contextMenuStyle: any = { 
    position: 'absolute', 
    top: '75px', 
    right: '25px', 
    backgroundColor: '#111', 
    border: '1px solid #333', 
    borderRadius: '20px', 
    width: '220px', 
    overflow: 'hidden', 
    boxShadow: '0 20px 50px rgba(0,0,0,0.8)', 
    zIndex: 100,
    textAlign: 'left',
    animation: 'fadeIn 0.2s ease'
};

const menuItemStyle: any = { 
    padding: '16px 20px', 
    color: '#eee', 
    fontSize: '14px', 
    fontWeight: 'bold', 
    cursor: 'pointer', 
    borderBottom: '1px solid #1a1a1a', 
    transition: '0.2s' 
};

const sectionTitle: any = { fontSize: '12px', fontWeight: '900', color: '#444', marginBottom: '15px', letterSpacing: '2px', textAlign: 'center', textTransform: 'uppercase' };

const progressSectionStyle: any = { background: '#161816', padding: '35px', borderRadius: '35px', border: '1px solid #222', marginBottom: '35px' };
const labelRow: any = { display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '13px', fontWeight: '900' };
const barBg: any = { width: '100%', height: '10px', background: '#000', borderRadius: '12px', overflow: 'hidden' };
const barFill: any = { height: '100%', background: '#0abab5', transition: '1.2s cubic-bezier(0.4, 0, 0.2, 1)' };

const contactCardStyle: any = { background: '#161816', padding: '30px', borderRadius: '30px', border: '1px solid #222' };
const contactIconStyle: any = { width: '45px', height: '45px', background: '#000', color: '#0abab5', border: '1px solid rgba(10,186,181,0.25)', borderRadius: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: '900', fontFamily: 'Inter, sans-serif' };
const avatarFallbackText: any = { color: '#0abab5', fontSize: '32px', fontWeight: '900', letterSpacing: '2px' };

const overlayStyle: any = { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20000, padding: '20px', backdropFilter: 'blur(10px)', boxSizing: 'border-box' };

const modalStyle: any = { 
    background: '#111', 
    borderRadius: '40px', 
    border: '1px solid #222',
    padding: '40px 35px',
    width: '100%',
    maxWidth: '500px',
    boxSizing: 'border-box',
    boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8)'
};

const inputItemStyle: any = { width: '100%', padding: '20px', background: '#000', border: '1px solid #222', borderRadius: '18px', color: '#fff', outline: 'none', fontSize: '16px', boxSizing: 'border-box' };
const saveButtonStyle: any = { width: '100%', padding: '22px', background: '#0abab5', border: 'none', borderRadius: '18px', fontWeight: '900', color: '#000', cursor: 'pointer', marginTop: '20px', fontSize: '15px' };
const cancelButtonStyle: any = { textAlign: 'center', marginTop: '25px', color: '#444', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' };

const notificationHelpBtnStyle = {
    width: '100%',
    padding: '20px',
    marginTop: '15px',
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.1)',
    color: '#888',
    borderRadius: '25px',
    fontWeight: '900',
    cursor: 'pointer',
    fontSize: '13px',
    transition: '0.3s',
};

const tabStyle = (isActive: boolean) => ({
    flex: 1,
    textAlign: 'center',
    padding: '12px 5px',
    cursor: 'pointer',
    color: isActive ? '#000' : '#888',
    background: isActive ? '#0abab5' : 'transparent',
    fontWeight: '900',
    fontSize: '14px',
    borderRadius: '10px',
    transition: '0.2s'
});

const helpDescStyle = {
    fontSize: '15px',
    color: '#ccc',
    lineHeight: '1.6',
    marginBottom: '25px',
    padding: '0 5px'
};

const stepCardStyle = {
    display: 'flex',
    gap: '20px',
    alignItems: 'center',
    background: '#161816',
    padding: '20px 25px',
    borderRadius: '18px',
    border: '1px solid #222',
    marginBottom: '15px'
};

const stepNumStyle = {
    width: '45px',
    height: '45px',
    background: 'rgba(10,186,181,0.1)',
    color: '#0abab5',
    borderRadius: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: '900',
    fontSize: '18px',
    flexShrink: 0
};

const stepTextStyle = {
    fontSize: '15px',
    color: '#eee',
    lineHeight: '1.6'
};

export default function ProfilePage() {
    return <Suspense fallback={<div style={{backgroundColor: '#0d0f0d', minHeight: '100vh'}} />}><ProfileContent /></Suspense>;
}
