"use client";
import React from 'react';
import { modalOverlay, adminIn, delIconStyle, adminActionBtn, saveBtn } from './adminStyles';

const modalContentMedium: React.CSSProperties = { background: '#111', padding: '40px 30px', borderRadius: '35px', width: '100%', maxWidth: '600px', border: '1px solid #333', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8)' };
const cancelLink: React.CSSProperties = { textAlign: 'center', marginTop: '20px', color: '#666', cursor: 'pointer', fontWeight: 'bold', fontSize: '14px' };

export default function TestEditorModal({
    testFormData, setTestFormData, updateTestQuestion,
    removeTestQuestion, addTestQuestion, handleSendTest, isProcessing, setShowTestEditor
}: any) {

    // --- ЛОГИКА КОНВЕРТАЦИИ ТАЙМЕРА (Из долей минут в ММ:СС) ---
    const currentMins = Math.floor(testFormData.timeLimit || 0);
    const currentSecs = Math.round(((testFormData.timeLimit || 0) - currentMins) * 60);

    const handleTimeChange = (type: 'm' | 's', val: string) => {
        let num = parseInt(val.replace(/\D/g, ''), 10);
        if (isNaN(num)) num = 0;
        
        // Защита от ввода 60+ секунд
        if (type === 's' && num > 59) num = 59;
        
        let newMins = type === 'm' ? num : currentMins;
        let newSecs = type === 's' ? num : currentSecs;
        
        // Конвертируем обратно в десятичную дробь для сервера
        setTestFormData({...testFormData, timeLimit: newMins + (newSecs / 60)});
    };

    return (
        <div style={{...modalOverlay, alignItems: 'flex-start'} as any} onClick={() => setShowTestEditor(false)}>
            <div className="admin-modal-content custom-scroll" style={{...modalContentMedium, margin: '40px auto', maxHeight: '85vh', overflowY: 'auto'} as any} onClick={e => e.stopPropagation()}>
                <h2 style={{ textAlign: 'center', marginBottom: '25px', color: '#0abab5', fontWeight: '900', textTransform: 'uppercase' }}>
                    РЕДАКТОР АТТЕСТАЦИИ
                </h2>
                
                <div style={{display: 'flex', flexDirection: 'column', gap: '20px', marginBottom: '25px'}}>
                    <div>
                        <div style={{ fontSize: '11px', color: '#888', fontWeight: 'bold', marginBottom: '5px', marginLeft: '5px', textTransform: 'uppercase' }}>Название аттестации</div>
                        <input autoComplete="new-password" style={{...adminIn, color: '#0abab5', fontWeight: 'bold'} as any} placeholder="Например: Итоговый экзамен" value={testFormData.title} onChange={e => setTestFormData({...testFormData, title: e.target.value})} />
                    </div>
                    
                    {/* НОВЫЙ БЛОК ТАЙМЕРА */}
                    <div>
                        <div style={{ fontSize: '11px', color: '#888', fontWeight: 'bold', marginBottom: '8px', marginLeft: '5px', textTransform: 'uppercase' }}>Лимит времени на тест:</div>
                        <div style={{ display: 'flex', gap: '20px', alignItems: 'center', background: '#000', padding: '15px 20px', borderRadius: '20px', border: '1px solid #222', flexWrap: 'wrap' }}>
                            
                            {/* Инпуты ручного ввода (МИН : СЕК) */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <div style={{ position: 'relative' }}>
                                    <input 
                                        type="text"
                                        value={currentMins === 0 && currentSecs === 0 ? '' : currentMins}
                                        onChange={(e) => handleTimeChange('m', e.target.value)}
                                        placeholder="00"
                                        style={{ width: '65px', padding: '12px 0', background: '#111', border: '1px solid #333', borderRadius: '12px', color: '#0abab5', fontSize: '20px', fontWeight: '900', textAlign: 'center', outline: 'none' }}
                                    />
                                    <span style={{ position: 'absolute', bottom: '-20px', left: '50%', transform: 'translateX(-50%)', fontSize: '10px', color: '#666', fontWeight: 'bold' }}>МИН</span>
                                </div>
                                
                                <span style={{ fontSize: '24px', color: '#555', fontWeight: '900', paddingBottom: '5px' }}>:</span>
                                
                                <div style={{ position: 'relative' }}>
                                    <input 
                                        type="text"
                                        value={currentMins === 0 && currentSecs === 0 ? '' : currentSecs}
                                        onChange={(e) => handleTimeChange('s', e.target.value)}
                                        placeholder="00"
                                        style={{ width: '65px', padding: '12px 0', background: '#111', border: '1px solid #333', borderRadius: '12px', color: '#0abab5', fontSize: '20px', fontWeight: '900', textAlign: 'center', outline: 'none' }}
                                    />
                                    <span style={{ position: 'absolute', bottom: '-20px', left: '50%', transform: 'translateX(-50%)', fontSize: '10px', color: '#666', fontWeight: 'bold' }}>СЕК</span>
                                </div>
                            </div>

                            <div style={{ width: '1px', height: '40px', background: '#222', margin: '0 5px' }} className="desktop-divider"></div>

                            {/* Быстрые кнопки */}
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', flex: 1 }}>
                                {[0, 1, 5, 10, 15, 30].map((t) => (
                                    <div 
                                        key={t}
                                        onClick={() => setTestFormData({...testFormData, timeLimit: t})} 
                                        style={{ 
                                            padding: '8px 14px', 
                                            background: testFormData.timeLimit === t ? '#0abab5' : '#1a1a1a', 
                                            color: testFormData.timeLimit === t ? '#000' : '#888', 
                                            borderRadius: '10px', 
                                            cursor: 'pointer', 
                                            fontSize: '12px', 
                                            fontWeight: '900', 
                                            transition: '0.2s',
                                            border: `1px solid ${testFormData.timeLimit === t ? '#0abab5' : '#333'}`,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                        }}
                                    >
                                        {t === 0 ? 'Без лимита Без лимита' : `${t} мин`}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                <div style={{borderTop: '1px dashed #333', paddingTop: '20px', marginTop: '10px'}}>
                    <h3 style={{fontSize: '16px', color: '#0abab5', marginBottom: '15px', fontWeight: '900'}}>ВОПРОСЫ ({testFormData.quiz.length})</h3>
                    {testFormData.quiz.map((q: any, qIdx: number) => (
                        <div key={qIdx} style={{background: '#0d0f0d', padding: '20px', borderRadius: '20px', border: '1px solid #222', marginBottom: '20px', position: 'relative'}}>
                            {testFormData.quiz.length > 1 && <div onClick={() => removeTestQuestion(qIdx)} style={{...delIconStyle, position: 'absolute', top: '15px', right: '15px'} as any}>X</div>}
                            
                            <input autoComplete="new-password" style={{...adminIn, fontWeight: 'bold', marginBottom: '15px', paddingRight: '40px'} as any} placeholder="Текст вопроса..." value={q.q} onChange={e => updateTestQuestion(qIdx, 'q', e.target.value)} />
                            
                            <div style={{display: 'flex', flexDirection: 'column', gap: '10px'}}>
                                {[0, 1, 2, 3].map((i: number) => (
                                    <div key={i} style={{display: 'flex', alignItems: 'center', gap: '10px', background: q.c === i ? 'rgba(10,186,181,0.1)' : 'transparent', padding: '10px', borderRadius: '10px', border: q.c === i ? '1px solid #0abab5' : '1px solid #222'}}>
                                        <input type="radio" style={{transform: 'scale(1.2)', cursor: 'pointer'}} checked={q.c === i} onChange={() => updateTestQuestion(qIdx, 'c', i)} />
                                        <input autoComplete="new-password" style={{...adminIn, padding: '10px', marginBottom: 0, border: 'none', background: 'transparent', width: '100%'} as any} placeholder={`Вариант ${i+1}`} value={q.o[i] || ''} onChange={e => updateTestQuestion(qIdx, `o${i}`, e.target.value)} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                    <button onClick={addTestQuestion} disabled={isProcessing} style={{...adminActionBtn, width: '100%', padding: '15px', background: 'transparent'} as any}>+ ДОБАВИТЬ ВОПРОС</button>
                </div>
                
                <button onClick={handleSendTest} disabled={isProcessing} style={{...saveBtn, marginTop: '30px', cursor: isProcessing ? 'not-allowed' : 'pointer', opacity: isProcessing ? 0.7 : 1} as any}>
                    {isProcessing ? 'ОТПРАВКА...' : 'ОТПРАВИТЬ СОТРУДНИКУ'}
                </button>
                
                <div onClick={() => setShowTestEditor(false)} style={cancelLink as any}>СВЕРНУТЬ (ДАННЫЕ СОХРАНЯТСЯ)</div>

                <style jsx>{`
                    @media (max-width: 768px) {
                        .desktop-divider { display: none !important; }
                    }
                `}</style>
            </div>
        </div>
    );
}