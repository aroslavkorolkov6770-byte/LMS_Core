"use client";
import React, { useState } from 'react';
import { flexSpace, sectionTitle, actionBtn, adminIn, userCardStyle, modalOverlay, modalContentSmall, saveBtn } from './adminStyles';
import CustomIcon from '@/app/components/CustomIcon';

const saveDataToServer = (key: string, data: any) => {
    return fetch('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, data })
    }).catch(err => console.error("Ошибка сохранения на сервер:", err));
};

export default function UserManagement({
    users, setUsers, userAvatars,
    setShowSuccessModal, setErrorModal, setSelectedProfileUser
}: any) {
    const [userSearchQuery, setUserSearchQuery] = useState("");
    const [showUserForm, setShowUserForm] = useState(false);
    const [newUser, setNewUser] = useState({ name: '', login: '', pass: '', role: 'staff' });
    const [confirmModal, setConfirmModal] = useState({ show: false, id: '' });

    const filteredUsers = users.filter((u: any) => 
        u.name.toLowerCase().includes(userSearchQuery.toLowerCase()) || 
        u.login.toLowerCase().includes(userSearchQuery.toLowerCase())
    );

    const handleCreateUser = () => {
        if (!newUser.name.trim() || !newUser.login.trim() || !newUser.pass.trim()) {
            setErrorModal({ show: true, text: "Заполните все поля!" }); return;
        }
        if (users.find((u: any) => u.login === newUser.login.trim())) {
            setErrorModal({ show: true, text: "Логин уже существует!" }); return;
        }
        const createdUser = { id: 'u_' + Date.now(), login: newUser.login.trim(), pass: newUser.pass.trim(), role: newUser.role, name: newUser.name.trim() };
        const updatedUsers = [...users, createdUser];
        setUsers(updatedUsers);
        saveDataToServer('core_lms_users_v1', updatedUsers);
        setShowUserForm(false);
        setShowSuccessModal({ show: true, title: 'СОТРУДНИК СОЗДАН', text: `Аккаунт для ${newUser.name} успешно добавлен.` });
        setNewUser({ name: '', login: '', pass: '', role: 'staff' });
    };

    const handleDeleteUser = (id: string) => {
        if (id === 'u_admin' || id === 'u_staff') {
            setErrorModal({ show: true, text: "Базовые аккаунты удалить нельзя!" }); return;
        }
        setConfirmModal({ show: true, id: id });
    };

    const executeDelete = async () => {
        const updatedUsers = users.filter((u: any) => u.id !== confirmModal.id);
        setUsers(updatedUsers);
        saveDataToServer('core_lms_users_v1', updatedUsers);
        try {
            const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_push_subscriptions_v1`);
            const subs = await res.json().catch(() => []);
            if (Array.isArray(subs)) {
                await saveDataToServer('core_lms_push_subscriptions_v1', subs.filter((s: any) => s.userId !== confirmModal.id));
            }
        } catch (e) {}
        setConfirmModal({ show: false, id: '' });
    };

    return (
        <>
            <div style={flexSpace as any}>
                <h2 style={sectionTitle as any}>Управление персоналом</h2>
                <span onClick={() => setShowUserForm(true)} style={actionBtn as any}>+ Новый сотрудник</span>
            </div>

            <div style={{ marginBottom: '20px', position: 'relative' }}>
                <span style={{ position: 'absolute', left: '16px', top: '15px', opacity: 0.5, display: 'flex', alignItems: 'center' }}><SearchIcon /></span>
                <input type="text" placeholder="Поиск по имени или логину..." value={userSearchQuery} onChange={(e) => setUserSearchQuery(e.target.value)} style={{ ...adminIn, paddingLeft: '45px', marginBottom: 0, background: '#111' } as any} />
            </div>
            
            <div className="custom-scroll keep-scroll" style={{ maxHeight: '380px', overflowY: 'auto', paddingRight: '5px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px' }}>
                    {filteredUsers.length === 0 ? (
                        <div style={{ color: '#555', padding: '20px 0', textAlign: 'center' }}>Сотрудники не найдены</div>
                    ) : (
                        filteredUsers.map((u: any) => {
                            const avatarImg = userAvatars[u.id] || u.avatar;
                            return (
                            <div key={u.id} style={userCardStyle as any}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
                                    <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
                                        <div style={{ width: '45px', height: '45px', borderRadius: '15px', background: '#222', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            {avatarImg ? <img src={avatarImg} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={avatarFallbackText as any}>TH</span>}
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 900, fontSize: '18px', color: '#fff', marginBottom: '4px' }}>{u.name}</div>
                                            <div style={{ fontSize: '12px', color: u.role === 'admin' ? '#ff7675' : '#0abab5', fontWeight: 'bold' }}>{u.role === 'admin' ? 'Администратор' : 'Сотрудник'}</div>
                                        </div>
                                    </div>
                                    {(u.id !== 'u_admin' && u.id !== 'u_staff') && (
                                        <div onClick={() => handleDeleteUser(u.id)} style={{ cursor: 'pointer', color: '#ff4d4d', background: 'rgba(255,77,77,0.1)', padding: '5px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold', display: 'inline-flex' }}><CustomIcon name="close" size={15} color="#ff4d4d" /></div>
                                    )}
                                </div>
                                <div style={{ background: '#000', padding: '12px', borderRadius: '15px', border: '1px solid #222' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '8px' }}>
                                        <span style={{ color: '#666' }}>Логин:</span><span style={{ color: '#fff', fontFamily: 'monospace', fontWeight: 'bold' }}>{u.login}</span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                        <span style={{ color: '#666' }}>Пароль:</span><span style={{ color: '#fff', fontFamily: 'monospace', fontWeight: 'bold' }}>{u.pass}</span>
                                    </div>
                                </div>
                            </div>
                            )
                        })
                    )}
                </div>
            </div>

            {/* Модалки создания и удаления */}
            {showUserForm && (
                <div style={modalOverlay as any}>
                    <div style={modalContentSmall as any}>
                        <h2 style={{color:'#0abab5', marginBottom:'25px', fontWeight: '900', textAlign: 'center'}}>НОВЫЙ СОТРУДНИК</h2>
                        <input style={adminIn as any} placeholder="Имя (напр. Анна)" value={newUser.name} onChange={e=>setNewUser({...newUser, name: e.target.value})} />
                        <input style={adminIn as any} placeholder="Логин" value={newUser.login} onChange={e=>setNewUser({...newUser, login: e.target.value})} />
                        <input style={adminIn as any} placeholder="Пароль" value={newUser.pass} onChange={e=>setNewUser({...newUser, pass: e.target.value})} />
                        
                        <div style={{ textAlign: 'left', marginBottom: '15px', color: '#888', fontSize: '13px', fontWeight: 'bold', marginLeft: '5px' }}>Роль пользователя:</div>
                        <select style={adminIn as any} value={newUser.role} onChange={e=>setNewUser({...newUser, role: e.target.value})}>
                            <option value="staff"> Чайный мастер (Сотрудник)</option>
                            <option value="admin"> Администратор</option>
                        </select>
                        <button onClick={handleCreateUser} style={{...saveBtn, marginTop: '20px'} as any}>СОЗДАТЬ УЧЕТКУ</button>
                        <div onClick={()=>setShowUserForm(false)} style={{textAlign:'center', marginTop:'20px', cursor:'pointer', color:'#666', fontWeight:'bold'}}>ОТМЕНА</div>
                    </div>
                </div>
            )}

            {confirmModal.show && (
                <div style={modalOverlay as any} onClick={() => setConfirmModal({ show: false, id: '' })}>
                    <div style={{...modalContentSmall, textAlign: 'center'} as any} onClick={e => e.stopPropagation()}>
                        <div style={warningBadgeStyle as any}><CustomIcon name="alert" size={34} color="#ff4d4d" /></div>
                        <h2 style={{ color: '#ff4d4d', fontWeight: '900', marginBottom: '15px' }}>УДАЛИТЬ?</h2>
                        <p style={{ color: '#ccc', fontSize: '15px', marginBottom: '25px' }}>Вы уверены, что хотите удалить сотрудника?</p>
                        <div style={{ display: 'flex', gap: '15px' }}>
                            <button onClick={() => setConfirmModal({ show: false, id: '' })} style={{...saveBtn, background: '#222', color: '#fff', flex: 1} as any}>ОТМЕНА</button>
                            <button onClick={executeDelete} style={{...saveBtn, background: '#ff4d4d', color: '#fff', flex: 1} as any}>УДАЛИТЬ</button>
                        </div>
                    </div>
                </div>
            )}
        </>
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

const avatarFallbackText = {
    color: '#0abab5',
    fontSize: '16px',
    fontWeight: '900',
    letterSpacing: '1px'
};

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
    margin: '0 auto 20px auto'
};
