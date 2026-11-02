"use client";
import React from 'react';
import CustomIcon from '@/app/components/CustomIcon';
import { 
    modalOverlay, profileHeaderCardStyle, profileSectionTitle, 
    progressSectionStyle, labelRow, barBg, barFill, badgeStyle, 
    contactCardStyle, contactIconStyle 
} from './adminStyles';

const avatarFallbackText = {
    color: '#0abab5',
    fontSize: '32px',
    fontWeight: '900',
    letterSpacing: '2px'
};

export default function UserProfileModal({
    selectedProfileUser, setSelectedProfileUser, userProfiles, usersStats,
    totalRouteSteps, totalBasicsModules, userAvatars, testResults,
    editAuthMode, setEditAuthMode, editAuthLogin, setEditAuthLogin,
    editAuthPass, setEditAuthPass, handleSaveUserAuth
}: any) {
    if (!selectedProfileUser) return null;

    const pData = userProfiles[selectedProfileUser.id] || {};
    const routeLen = usersStats[selectedProfileUser.id]?.route || 0;
    const basicsLen = usersStats[selectedProfileUser.id]?.basics || 0;
    const profileAvatar = userAvatars[selectedProfileUser.id] || selectedProfileUser.avatar;
    const tg = pData.tg || selectedProfileUser.tg || '';
    const email = pData.email || selectedProfileUser.email || '';
    const phone = pData.phone || selectedProfileUser.phone || '';

    const planPercent = Math.min((routeLen / (totalRouteSteps || 1)) * 100, 100);
    const basicsPercent = Math.min((basicsLen / (totalBasicsModules || 1)) * 100, 100);

    return (
        <div style={modalOverlay as any} onClick={() => { setSelectedProfileUser(null); setEditAuthMode(false); }}>
            <div className="custom-scroll" style={{ background: '#0d0f0d', padding: '40px 20px', borderRadius: '40px', width: '100%', maxWidth: '600px', maxHeight: '90vh', overflowY: 'auto', border: '1px solid #333' } as any} onClick={e => e.stopPropagation()}>
                
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
                    <div onClick={() => { setSelectedProfileUser(null); setEditAuthMode(false); }} style={{ cursor: 'pointer', fontSize: '24px', color: '#ff4d4d', fontWeight: 'bold' }}>X</div>
                </div>

                <section style={profileHeaderCardStyle as any}>
                    <div style={{ width: '130px', height: '130px', borderRadius: '45px', backgroundColor: '#000', margin: '0 auto 25px', border: '2px solid #4CAF50', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 15px 35px rgba(76, 175, 80, 0.2)' }}>
                        {profileAvatar ? <img src={profileAvatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="Profile" /> : <span style={avatarFallbackText as any}>TH</span>}
                    </div>
                    <h2 style={{ fontSize: '32px', fontWeight: '900', margin: '0 0 8px 0', color: '#fff' }}>{selectedProfileUser.name}</h2>
                    <p style={{ color: '#0abab5', fontWeight: 'bold', fontSize: '13px', margin: 0, letterSpacing: '2px', textTransform: 'uppercase' }}>ЧАЙНЫЙ МАСТЕР (УЧЕНИК)</p>
                </section>

                <div style={{ background: 'rgba(255,77,77,0.05)', border: '1px solid rgba(255,77,77,0.2)', padding: '20px', borderRadius: '20px', marginBottom: '35px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', paddingBottom: '10px', borderBottom: '1px solid rgba(255,77,77,0.2)' }}>
                        <span style={{color: '#ff7675', fontWeight: '900', fontSize: '13px', letterSpacing: '1px'}}>ДАННЫЕ АВТОРИЗАЦИИ</span>
                        <button onClick={() => {
                            if(editAuthMode) { handleSaveUserAuth(); } 
                            else { setEditAuthLogin(selectedProfileUser.login); setEditAuthPass(selectedProfileUser.pass); setEditAuthMode(true); }
                        }} style={{ background: editAuthMode ? '#ff7675' : 'transparent', color: editAuthMode ? '#000' : '#ff7675', border: '1px solid #ff7675', padding: '6px 15px', borderRadius: '10px', cursor: 'pointer', fontSize: '11px', fontWeight: '900', transition: '0.2s' }}>
                            {editAuthMode ? 'СОХРАНИТЬ' : 'РЕДАКТИРОВАТЬ'}
                        </button>
                    </div>
                    
                    <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                        <div style={{textAlign: 'center'}}>
                            <div style={{fontSize: '11px', color: '#ff7675', fontWeight: 'bold', marginBottom: '8px'}}>ЛОГИН ДОСТУПА</div>
                            {editAuthMode ? (
                                <input value={editAuthLogin} onChange={e => setEditAuthLogin(e.target.value)} style={{ background: '#000', color: '#fff', border: '1px solid #ff7675', borderRadius: '8px', padding: '8px', width: '120px', textAlign: 'center', outline: 'none', fontSize: '15px', fontWeight: 'bold' }} />
                            ) : (
                                <div style={{fontFamily: 'monospace', fontSize: '16px', color: '#fff', fontWeight: 'bold'}}>{selectedProfileUser.login}</div>
                            )}
                        </div>
                        <div style={{textAlign: 'center'}}>
                            <div style={{fontSize: '11px', color: '#ff7675', fontWeight: 'bold', marginBottom: '8px'}}>ПАРОЛЬ</div>
                            {editAuthMode ? (
                                <input value={editAuthPass} onChange={e => setEditAuthPass(e.target.value)} style={{ background: '#000', color: '#fff', border: '1px solid #ff7675', borderRadius: '8px', padding: '8px', width: '120px', textAlign: 'center', outline: 'none', fontSize: '15px', fontWeight: 'bold' }} />
                            ) : (
                                <div style={{fontFamily: 'monospace', fontSize: '16px', color: '#fff', fontWeight: 'bold'}}>{selectedProfileUser.pass}</div>
                            )}
                        </div>
                    </div>
                </div>

                <section style={progressSectionStyle as any}>
                    <div style={{ marginBottom: '25px' }}>
                        <div style={labelRow as any}><span style={{color:'#888'}}>ТЕОРИЯ</span><span style={{color:'#0abab5'}}>{routeLen}/{totalRouteSteps}</span></div>
                        <div style={barBg as any}><div style={{ ...barFill, width: `${planPercent}%` } as any} /></div>
                    </div>
                    <div style={{ marginBottom: '10px' }}>
                        <div style={labelRow as any}><span style={{color:'#888'}}>ТЕСТЫ</span><span style={{color:'#0abab5'}}>{basicsLen}/{totalBasicsModules}</span></div>
                        <div style={barBg as any}><div style={{ ...barFill, width: `${basicsPercent}%` } as any} /></div>
                    </div>
                </section>

                <h3 style={profileSectionTitle as any}>ЛИЧНЫЕ ДОСТИЖЕНИЯ</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '35px' }}>
                    <div title="Старт" style={{ ...badgeStyle, opacity: routeLen >= 1 ? 1 : 0.1 } as any}><CustomIcon name="sprout" size={22} color="#0abab5" /></div>
                    <div title="План" style={{ ...badgeStyle, opacity: routeLen >= 5 ? 1 : 0.1 } as any}><CustomIcon name="rocket" size={22} color="#0abab5" /></div>
                    <div title="Теория" style={{ ...badgeStyle, opacity: basicsLen >= 5 ? 1 : 0.1 } as any}><CustomIcon name="book" size={22} color="#0abab5" /></div>
                    <div title="Мастер" style={{ ...badgeStyle, opacity: basicsLen >= 10 ? 1 : 0.1 } as any}><CustomIcon name="lantern" size={22} color="#0abab5" /></div>
                </div>

                <h3 style={profileSectionTitle as any}>СВЯЗЬ</h3>
                <section style={contactCardStyle as any}>
                    <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                        <div style={contactIconStyle as any}><CustomIcon name="chat" size={22} color="#0abab5" /></div>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: '16px', fontWeight: '900', color: '#fff', marginBottom: '4px' }}>{tg || 'telegram не указан'}</div>
                            <div style={{ fontSize: '14px', color: '#0abab5', fontWeight: 'bold', marginBottom: '2px' }}>{email || 'e-mail не указан'}</div>
                            <div style={{ fontSize: '13px', color: '#555' }}>{phone || 'телефон не указан'}</div>
                        </div>
                    </div>
                </section>

                <h3 style={{...profileSectionTitle, marginTop: '35px'} as any}>История аттестаций</h3>
                <div style={{ background: '#000', padding: '10px', borderRadius: '20px', border: '1px solid #222' }}>
                    {testResults.filter((r: any) => r.userName === selectedProfileUser.name && r.testName?.toLowerCase().includes('аттестация')).length === 0 ? (
                        <div style={{ padding: '20px', textAlign: 'center', color: '#666', fontSize: '13px', fontWeight: 'bold' }}>Сотрудник еще не сдавал аттестации</div>
                    ) : (
                        testResults.filter((r: any) => r.userName === selectedProfileUser.name && r.testName?.toLowerCase().includes('аттестация')).map((res: any) => {
                            const isPassed = res.score === 100;
                            const scoreColor = isPassed ? '#0abab5' : '#ff4d4d';
                            return (
                                <div key={res.id} style={{ padding: '15px', borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '15px' }}>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: '900', color: '#fff', fontSize: '14px', marginBottom: '4px' }}>{res.testName}</div>
                                        <div style={{ fontSize: '11px', color: '#888' }}>{res.date} • Попытка: {res.attempts}</div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontWeight: '900', color: scoreColor, fontSize: '16px' }}>{res.score}%</div>
                                        <span style={{ fontSize: '10px', fontWeight: '900', color: scoreColor }}>{isPassed ? 'ПРОЙДЕН' : 'ПРОФАЛ'}</span>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
