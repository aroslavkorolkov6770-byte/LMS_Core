"use client";
import React from 'react';
import { modalOverlay, modalContentSmall, adminIn, statusBadge } from './adminStyles';

export default function TestResultsModal({
    setShowTestModal, selectedTestUser, setSelectedTestUser, users, testResults
}: any) {
    return (
        <div style={modalOverlay as any} onClick={() => setShowTestModal(false)}>
            <div className="admin-modal-content" style={{ ...modalContentSmall, maxWidth: '650px', padding: '35px' } as any} onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
                    <h2 style={{ color: '#0abab5', fontWeight: '900', margin: 0, letterSpacing: '1px', fontSize: '18px' }}>РЕЗУЛЬТАТЫ ТЕСТОВ</h2>
                    <div onClick={() => setShowTestModal(false)} style={{ cursor: 'pointer', fontSize: '24px', color: '#ff4d4d', lineHeight: 1, fontWeight: 'bold' }}>X</div>
                </div>

                <select
                    style={{ ...adminIn, marginBottom: '25px', border: '1px solid #333' } as any}
                    value={selectedTestUser}
                    onChange={(e) => setSelectedTestUser(e.target.value)}
                >
                    <option value="Все">Показать всех сотрудников</option>
                    {users.filter((u: any) => u.role === 'staff').map((u: any) => (
                        <option key={u.id} value={u.name}>{u.name} ({u.login})</option>
                    ))}
                </select>

                <div style={{ maxHeight: '450px', overflowY: 'auto', paddingRight: '10px' }} className="custom-scroll">
                    {testResults
                        .filter((res: any) => (selectedTestUser === 'Все' || res.userName === selectedTestUser))
                        .map((res: any) => {
                            const isPassed = res.score === 100;
                            const scoreColor = isPassed ? '#0abab5' : '#ff4d4d';

                            return (
                                <div key={res.id} style={{ background: '#000', border: '1px solid #222', padding: '20px', borderRadius: '20px', marginBottom: '15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '15px' }}>
                                    <div style={{ flex: 1, minWidth: '150px' }}>
                                        <div style={{ fontWeight: '900', color: '#fff', fontSize: '16px', marginBottom: '6px' }}>{res.testName}</div>
                                        <div style={{ fontSize: '13px', color: '#888' }}>Сотрудник: <span style={{color: '#ccc', fontWeight: 'bold'}}>{res.userName}</span> • Попыток: {res.attempts}</div>
                                    </div>
                                    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
                                        <div style={{ fontWeight: '900', color: scoreColor, fontSize: '20px' }}>{res.score}%</div>
                                        <span style={statusBadge(scoreColor) as any}>{isPassed ? 'Пройден' : 'Не пройден'}</span>
                                    </div>
                                </div>
                            );
                    })}
                    {testResults.filter((res: any) => (selectedTestUser === 'Все' || res.userName === selectedTestUser)).length === 0 && (
                        <div style={{ textAlign: 'center', color: '#666', padding: '30px', fontWeight: 'bold', fontSize: '15px' }}>Нет результатов тестирований</div>
                    )}
                </div>
            </div>
        </div>
    );
}