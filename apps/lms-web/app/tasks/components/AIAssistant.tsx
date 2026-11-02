"use client";
import React, { useState, useEffect, useRef } from 'react';
import CustomIcon from '@/app/components/CustomIcon';

interface Message {
    id: string;
    role: 'user' | 'ai';
    content: string;
    timestamp: string;
}

interface ChatSession {
    id: string;
    title: string;
    messages: Message[];
    updatedAt: number;
    isPinned?: boolean; 
}

export default function AIAssistant({ userId, isAdmin }: { userId?: string, isAdmin?: boolean }) {
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [inputValue, setInputValue] = useState("");
    const [isTyping, setIsTyping] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [isMobileHistoryOpen, setIsMobileHistoryOpen] = useState(false);
    
    const [currentUserId, setCurrentUserId] = useState<string | null>(null);
    
    const chatContainerRef = useRef<HTMLDivElement>(null);

    const industryTemplate = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('previewIndustryTemplate') ?? 'coffee_shop'
      : 'coffee_shop';
    const isRetail = industryTemplate === 'retail_store';
    const quickPrompts = isRetail
      ? [
          "Как действовать при возврате товара без конфликта?",
          "Что проверить при открытии смены в магазине?",
          "Сценарий общения, если покупатель раздражен"
        ]
      : [
          "Как правильно заваривать Те Гуань Инь?",
          "Что делать, если сломалась кофемашина?",
          "Сценарий общения, если гость грубит"
        ];

    // =========================================================================
    // ОПРЕДЕЛЕНИЕ ПОЛЬЗОВАТЕЛЯ (АДМИН - 100% ПРИОРИТЕТ)
    // =========================================================================
    useEffect(() => {
        const determineUser = () => {
            if (isAdmin === true || localStorage.getItem('userRole') === 'admin' || userId === 'admin') {
                return 'admin_master'; 
            }

            if (userId && userId !== 'guest' && userId.trim() !== '') {
                return 'emp_' + String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
            }

            let foundId = localStorage.getItem('current_user_id') || localStorage.getItem('login') || localStorage.getItem('userId');
            if (foundId && foundId !== 'guest' && foundId !== 'null') {
                return 'emp_' + String(foundId).replace(/[^a-zA-Z0-9_-]/g, '_');
            }

            let guestId = localStorage.getItem('th_stable_guest_id');
            if (!guestId) {
                guestId = 'guest_' + Math.random().toString(36).substr(2, 9);
                localStorage.setItem('th_stable_guest_id', guestId);
            }
            return guestId;
        };

        const activeUser = determineUser();
        setCurrentUserId(activeUser);

        const loadHistory = async () => {
            let serverDataFound = false;
            const historyKey = `th_ai_history_${activeUser}`;

            try {
                const res = await fetch(`/api/storage?key=${historyKey}&t=${Date.now()}`);
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data) && data.length > 0) {
                        setSessions(data);
                        setActiveSessionId(data[0].id);
                        localStorage.removeItem(historyKey);
                        serverDataFound = true;
                    }
                }
            } catch (e) {
                console.warn("Сервер истории AI временно недоступен");
            }

            if (!serverDataFound) {
                const savedSessions = localStorage.getItem(historyKey);

                if (savedSessions) {
                    try {
                        const parsed = JSON.parse(savedSessions);

                        if (Array.isArray(parsed) && parsed.length > 0) {
                            setSessions(parsed);
                            setActiveSessionId(parsed[0].id);

                            const migrationResponse = await fetch('/api/storage', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    key: historyKey,
                                    data: parsed
                                })
                            });

                            if (migrationResponse.ok) {
                                localStorage.removeItem(historyKey);
                            }
                        }
                    } catch (error) {
                        console.error("Не удалось перенести старую историю AI", error);
                    }
                }
            }
        };

        loadHistory();
    }, [userId, isAdmin]); 

    useEffect(() => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    }, [sessions, activeSessionId, isTyping]);

    const saveSessions = async (newSessions: ChatSession[]) => {
        setSessions(newSessions);
        if (!currentUserId) return;

        const historyKey = `th_ai_history_${currentUserId}`;

        try {
            const response = await fetch('/api/storage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: historyKey,
                    data: newSessions
                })
            });

            if (!response.ok) {
                throw new Error(`Сервер вернул статус ${response.status}`);
            }

            localStorage.removeItem(historyKey);
        } catch (error) {
            console.error("Ошибка защищенного сохранения истории AI", error);
        }
    };

    const createNewSession = () => {
        const newSession: ChatSession = {
            id: `chat_${Date.now()}`,
            title: "Новый диалог",
            messages: [],
            updatedAt: Date.now()
        };
        saveSessions([newSession, ...sessions]);
        setActiveSessionId(newSession.id);
        setIsMobileHistoryOpen(false); 
    };

    const clearHistory = () => {
        saveSessions([]);
        setActiveSessionId(null);
        setShowClearConfirm(false);
        setIsMobileHistoryOpen(false);
    };

    const deleteSession = (sessionId: string, e: React.MouseEvent) => {
        e.stopPropagation(); 
        const filtered = sessions.filter((s: ChatSession) => s.id !== sessionId);
        saveSessions(filtered);
        
        if (activeSessionId === sessionId) {
            setActiveSessionId(filtered.length > 0 ? sortedSessions.filter(s => s.id !== sessionId)[0]?.id || null : null);
        }
    };

    const togglePin = (sessionId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const updated = sessions.map(s => s.id === sessionId ? { ...s, isPinned: !s.isPinned } : s);
        saveSessions(updated);
    };

    const sortedSessions = [...sessions].sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return b.updatedAt - a.updatedAt;
    });

    const handleSendMessage = async (text: string) => {
        if (!text.trim() || !currentUserId) return;

        let currentActiveId = activeSessionId;
        let currentSessions = [...sessions];

        if (!currentActiveId || currentSessions.length === 0) {
            const newSession: ChatSession = {
                id: `chat_${Date.now()}`,
                title: text.slice(0, 25) + "...",
                messages: [],
                updatedAt: Date.now()
            };
            currentSessions = [newSession, ...currentSessions];
            currentActiveId = newSession.id;
            setActiveSessionId(currentActiveId);
        }

        const userMsg: Message = {
            id: `msg_${Date.now()}`,
            role: 'user',
            content: text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        let updatedSessions = currentSessions.map((s: ChatSession) => {
            if (s.id === currentActiveId) {
                const newTitle = s.messages.length === 0 ? text.slice(0, 25) + "..." : s.title;
                return { ...s, title: newTitle, messages: [...s.messages, userMsg], updatedAt: Date.now() };
            }
            return s;
        }); 

        saveSessions(updatedSessions);
        setInputValue("");
        setIsTyping(true);

        try {
            const routeCache = JSON.parse(localStorage.getItem('th_cache_route') || '[]');
            const testsCache = JSON.parse(localStorage.getItem('th_cache_tests') || '[]');
            
            let siteContext = "";
            if (routeCache.length > 0 || testsCache.length > 0) {
                siteContext += "=== СЕКРЕТНЫЙ КОНТЕКСТ (БАЗА ЗНАНИЙ КОМПАНИИ ИЗ ПАНЕЛИ АДМИНА) ===\n";
                
                if (routeCache.length > 0) {
                    siteContext += "РАЗДЕЛ 'ТЕОРИЯ' (Сгруппировано по папкам):\n";
                    const routeGroups: Record<string, any[]> = {};
                    routeCache.forEach((route: any) => {
                        const sec = route.section?.trim() || 'Основной раздел';
                        if (!routeGroups[sec]) routeGroups[sec] = [];
                        if (!route.isPlaceholder) routeGroups[sec].push(route);
                    });

                    Object.entries(routeGroups).forEach(([secName, items]) => {
                        siteContext += `\n📁 ПАПКА: "${secName}"\n`;
                        items.forEach((route: any, idx: number) => {
                            siteContext += `  - Урок ${idx + 1}: ${route.title} (ID: ${route.id})\n`;
                            
                            // ИСПРАВЛЕНИЕ: Теперь ИИ видит описание видеоуроков
                            if (route.mediaType === 'video') {
                                if (route.videoDesc) siteContext += `    * Описание видео: ${route.videoDesc}\n`;
                            } else {
                                if (route.h1) siteContext += `    * ${route.h1}: ${route.t1}\n`;
                                if (route.h2) siteContext += `    * ${route.h2}: ${route.t2}\n`;
                                if (route.h3) siteContext += `    * ${route.h3}: ${route.t3}\n`;
                            }
                        });
                    });
                }
                
                if (testsCache.length > 0) {
                    siteContext += "\nРАЗДЕЛ 'ТЕСТЫ' (Сгруппировано по папкам):\n";
                    const testGroups: Record<string, any[]> = {};
                    testsCache.forEach((test: any) => {
                        const sec = test.section?.trim() || 'Основной раздел';
                        if (!testGroups[sec]) testGroups[sec] = [];
                        if (!test.isPlaceholder) testGroups[sec].push(test);
                    });

                    Object.entries(testGroups).forEach(([secName, items]) => {
                        siteContext += `\n📁 ПАПКА: "${secName}"\n`;
                        items.forEach((test: any, idx: number) => {
                            siteContext += `  - Тест ${idx + 1}: ${test.title} (${test.subtitle}). База: ${test.theory}\n`;
                        });
                    });
                }
                
                siteContext += "\n=== КОНЕЦ БАЗЫ ЗНАНИЙ ===\n";
                
                siteContext += "ВАЖНОЕ ПРАВИЛО НАВИГАЦИИ ПО УРОКАМ: Все уроки и тесты сгруппированы по папкам (разделам). Нумерация (Урок 1, Урок 2) начинается ЗАНОВО внутри каждой папки! Если пользователь просит 'Включи урок 1' или 'Расскажи первую тему', ты должен ОБЯЗАТЕЛЬНО понять из контекста или переспросить: 'Урок 1 из какого раздела (папки) вас интересует?'.\nОпирайся СТРОГО на этот текст.\n\n";
            }

            const currentSession = updatedSessions.find((s: ChatSession) => s.id === currentActiveId);
            
            const apiMessages = currentSession ? currentSession.messages.map((m, index) => {
                let finalContent = m.content;
                if (index === currentSession.messages.length - 1 && m.role === 'user') {
                    finalContent = `${siteContext}ВОПРОС ПОЛЬЗОВАТЕЛЯ:\n${m.content}`;
                }
                return { role: m.role === 'ai' ? 'assistant' : 'user', content: finalContent };
            }) : [];

            const response = await fetch('/api/ai-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: apiMessages })
            });

            const data = await response.json();

            // ИСПРАВЛЕНИЕ: Перехват ошибки о закончившихся токенах (внутри ответа 200 OK)
            if (data.error) {
                const errStr = JSON.stringify(data.error).toLowerCase();
                if (errStr.includes('quota') || errStr.includes('token') || errStr.includes('limit') || errStr.includes('баланс') || errStr.includes('429')) {
                    throw new Error("TOKEN_LIMIT_EXCEEDED");
                }
                throw new Error(JSON.stringify(data.error));
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);

            let aiText = "";
            if (Array.isArray(data.output)) {
                const msgObj = data.output.find((o: any) => o.type === 'message' && o.content);
                if (msgObj && Array.isArray(msgObj.content) && msgObj.content[0]?.text) {
                    aiText = msgObj.content[0].text;
                }
            }
            
            if (!aiText) {
                aiText = data.output_text || data.text || data.message?.text || data.message?.content?.text || data.choices?.[0]?.message?.content;
            }

            if (!aiText) {
                aiText = `🚨 СЫРОЙ ОТВЕТ ЯНДЕКСА:\n${JSON.stringify(data, null, 2)}`;
            }

            const aiMsg: Message = {
                id: `msg_${Date.now() + 1}`,
                role: 'ai',
                content: aiText,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            const finalSessions = updatedSessions.map((s: ChatSession) => 
                s.id === currentActiveId ? { ...s, messages: [...s.messages, aiMsg] } : s
            );
            saveSessions(finalSessions);

        } catch (error: any) {
            console.error("❌ ОШИБКА:", error);

            let displayError = `🚨 СИСТЕМНАЯ ОШИБКА:\n\n${error.message}`;
            const errStr = error.message?.toLowerCase() || '';
            
            // ИСПРАВЛЕНИЕ: Перехват системной ошибки о токенах
            if (errStr.includes('token') || errStr.includes('quota') || errStr.includes('429') || errStr.includes('402') || errStr.includes('limit') || errStr.includes('баланс') || errStr.includes('too many requests')) {
                displayError = "⚠️ Токены закончились, просьба обратиться к администратору.";
            }

            const errorMsg: Message = {
                id: `msg_${Date.now() + 1}`, role: 'ai',
                content: displayError,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            const finalSessions = updatedSessions.map((s: ChatSession) => 
                s.id === currentActiveId ? { ...s, messages: [...s.messages, errorMsg] } : s
            );
            saveSessions(finalSessions);
        } finally {
            setIsTyping(false); 
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage(inputValue);
        }
    };

    const activeSession = sessions.find((s: ChatSession) => s.id === activeSessionId);

    if (!currentUserId) {
        return null;
    }

    return (
        <section className="ai-monolithic-section lms-ai-page" style={{ animation: 'fadeInUp 0.5s ease' }}>
            <div className="ai-monolithic-container">
                {isMobileHistoryOpen && (
                    <div className="ai-mobile-overlay" onClick={() => setIsMobileHistoryOpen(false)}></div>
                )}
                
                {/* --- БОКОВАЯ ПАНЕЛЬ ИСТОРИИ --- */}
                <div className={`ai-sidebar custom-scroll ${isMobileHistoryOpen ? 'open' : ''}`}>
                    <div style={{ padding: '20px' }}>
                        <button 
                            onClick={createNewSession}
                            style={{ width: '100%', padding: '14px', background: 'transparent', border: '1px solid #0abab5', color: '#0abab5', borderRadius: '12px', fontWeight: '900', cursor: 'pointer', transition: '0.2s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                        >
                            <span style={{ fontSize: '18px' }}>+</span> НОВЫЙ ДИАЛОГ
                        </button>
                    </div>

                    <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px' }}>
                        <div className="ai-history-label" style={{ fontSize: '11px', color: '#666', fontWeight: '900', letterSpacing: '1px', marginBottom: '15px', paddingLeft: '10px' }}>ИСТОРИЯ ЗАПРОСОВ</div>
                        
                        {sortedSessions.map((s: ChatSession) => (
                            <div 
                                key={s.id} 
                                onClick={() => { setActiveSessionId(s.id); setIsMobileHistoryOpen(false); }}
                                className={`ai-session-item ${activeSessionId === s.id ? 'active' : ''}`}
                            >
                                <div className="ai-session-title">
                                    {s.title}
                                </div>
                                
                                <div className={`ai-session-actions ${s.isPinned ? 'pinned' : ''}`}>
                                    <button 
                                        className={`ai-pin-btn ${s.isPinned ? 'active' : ''}`} 
                                        onClick={(e) => togglePin(s.id, e)}
                                        title={s.isPinned ? "Открепить" : "Закрепить"}
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill={s.isPinned ? "#ffd700" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="12" y1="17" x2="12" y2="22"></line>
                                            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.68V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3v4.68a2 2 0 0 1-1.11 1.87l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
                                        </svg>
                                    </button>
                                    
                                    <button 
                                        className="ai-session-del-btn" 
                                        onClick={(e) => deleteSession(s.id, e)}
                                        title="Удалить диалог"
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="18" y1="6" x2="6" y2="18"></line>
                                            <line x1="6" y1="6" x2="18" y2="18"></line>
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="ai-account-id" style={{ padding: '10px 20px', fontSize: '10px', color: '#444', textAlign: 'center', borderTop: '1px solid #1a1a1a', fontWeight: 'bold' }}>
                        ID аккаунта: {currentUserId}
                    </div>

                    {sessions.length > 0 && (
                        <div className="ai-history-clear-zone" style={{ padding: '20px', borderTop: '1px solid #1a1a1a' }}>
                            <button 
                                onClick={() => setShowClearConfirm(true)}
                                style={{ width: '100%', padding: '12px', background: 'rgba(255,77,77,0.1)', color: '#ff4d4d', border: 'none', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer', fontSize: '13px', transition: '0.2s' }}
                            >
                                ОЧИСТИТЬ ИСТОРИЮ
                            </button>
                        </div>
                    )}
                </div>

                {/* --- ОКНО ДИАЛОГА --- */}
                <div className="ai-chat-area">
                    <div className="ai-mobile-header">
                        <div className="ai-mobile-title" style={{ fontWeight: '900', color: '#fff', fontSize: '16px' }}>TeaMaster <span style={{ color: '#0abab5' }}>AI</span></div>
                        <button onClick={() => setIsMobileHistoryOpen(true)} className="ai-history-btn">🕒 История</button>
                    </div>

                    <div className="ai-messages custom-scroll" ref={chatContainerRef}>
                        
                        {!activeSession || activeSession.messages.length === 0 ? (
                            <div className="ai-empty-state">
                                <div style={{ fontSize: '50px', marginBottom: '20px' }}>🤖</div>
                                <h3 className="ai-empty-title" style={{ color: '#fff', fontSize: '22px', fontWeight: '900', marginBottom: '10px' }}>TeaMaster AI</h3>
                                <p className="ai-empty-description" style={{ color: '#666', fontSize: '15px', marginBottom: '30px', lineHeight: '1.5' }}>
                                    {isRetail
                                      ? "Задайте любой вопрос по стандартам магазина, работе кассы, выкладке или каталогу товаров."
                                      : "Задайте любой вопрос по регламентам, стандартам сервиса или товарной матрице компании."}
                                </p>
                                <div className="quick-prompts-container">
                                    {quickPrompts.map((prompt, idx) => (
                                        <div 
                                            key={idx} 
                                            onClick={() => handleSendMessage(prompt)}
                                            className="quick-prompt"
                                        >
                                            {prompt}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            activeSession.messages.map((msg: Message) => (
                                <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: '20px' }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', maxWidth: '85%', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
                                        <div className={`ai-avatar ${msg.role}`}>
                                            {msg.role === 'user' ? '👤' : '🤖'}
                                        </div>
                                        <div className={`ai-bubble ${msg.role}`} style={msg.content.includes('СИСТЕМНАЯ ОШИБКА') || msg.content.includes('СЫРОЙ ОТВЕТ') ? { border: '1px solid #ff4d4d', background: 'rgba(255,77,77,0.1)' } : {}}>
                                            {msg.content}
                                        </div>
                                    </div>
                                    <div className="ai-message-time" style={{ fontSize: '11px', color: '#555', marginTop: '6px', padding: msg.role === 'user' ? '0 52px 0 0' : '0 0 0 52px' }}>
                                        {msg.timestamp}
                                    </div>
                                </div>
                            ))
                        )}

                        {isTyping && (
                            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', maxWidth: '85%', marginBottom: '20px' }}>
                                <div className="ai-avatar ai">🤖</div>
                                <div className="ai-bubble ai" style={{ padding: '15px 25px' }}>
                                    <div className="typing-indicator">
                                        <span></span><span></span><span></span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="ai-input-wrapper">
                        <div className="ai-input-box">
                            <textarea
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Спросить TeaMaster AI..."
                                className="custom-scroll ai-textarea"
                                rows={1}
                            />
                            <button 
                                onClick={() => handleSendMessage(inputValue)}
                                disabled={!inputValue.trim() || isTyping}
                                className="ai-send-btn"
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                            </button>
                        </div>
                        <div className="ai-footer-text">
                            ИИ может допускать ошибки. Проверяйте важную информацию по регламентам.
                        </div>
                    </div>
                </div>
            </div>

            {showClearConfirm && (
                <div className="ai-clear-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.85)', zIndex: 50000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>
                    <div className="ai-clear-modal" style={{ background: '#111', padding: '40px', borderRadius: '30px', border: '1px solid #333', textAlign: 'center', maxWidth: '400px', width: '90%' }}>
                        <div style={{ width: '60px', height: '60px', borderRadius: '18px', border: '1px solid rgba(255,77,77,0.35)', background: 'rgba(255,77,77,0.08)', color: '#ff4d4d', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 15px auto' }}><CustomIcon name="alert" size={34} color="#ff4d4d" /></div>
                        <h2 style={{ fontSize: '22px', color: '#ff4d4d', marginBottom: '15px', fontWeight: '900' }}>УДАЛИТЬ ИСТОРИЮ?</h2>
                        <p className="ai-clear-description" style={{ color: '#aaa', fontSize: '14px', marginBottom: '30px', lineHeight: '1.5' }}>
                            Вы собираетесь безвозвратно удалить все диалоги с нейросетью. Это действие нельзя отменить.
                        </p>
                        <div style={{ display: 'flex', gap: '15px' }}>
                            <button onClick={clearHistory} style={{ flex: 1, padding: '15px', background: '#ff4d4d', color: '#fff', border: 'none', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer' }}>УДАЛИТЬ</button>
                            <button className="ai-clear-cancel" onClick={() => setShowClearConfirm(false)} style={{ flex: 1, padding: '15px', background: '#222', color: '#fff', border: 'none', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer' }}>ОТМЕНА</button>
                        </div>
                    </div>
                </div>
            )}

            <style jsx global>{`
                .ai-monolithic-section { margin: -20px -60px -60px -60px; height: calc(100vh - 100px); display: flex; flex-direction: column; }
                .ai-monolithic-container { display: flex; flex: 1; background: transparent; height: 100%; }
                .ai-sidebar { width: 300px; border-right: 1px solid #1a1a1a; display: flex; flex-direction: column; background: transparent; transition: 0.3s ease; }
                .ai-session-item { position: relative; padding: 14px 15px; margin-bottom: 8px; cursor: pointer; border: 1px solid transparent; transition: all 0.2s ease; display: flex; justify-content: space-between; align-items: center; border-radius: 12px; }
                .ai-session-item.active { background: #1a1a1a; border-color: #333; }
                .ai-session-item:hover { border-color: #ff4d4d !important; box-shadow: 0 0 10px rgba(255, 77, 77, 0.15); background: rgba(255, 77, 77, 0.02); }
                .ai-session-title { color: #aaa; font-size: 14px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; padding-right: 10px; }
                .ai-session-item.active .ai-session-title { color: #0abab5; }
                
                .ai-session-actions { display: flex; align-items: center; gap: 8px; opacity: 0; transition: opacity 0.2s ease; }
                .ai-session-item:hover .ai-session-actions { opacity: 1; }
                .ai-session-actions.pinned { opacity: 1; }

                .ai-pin-btn { background: transparent; border: none; cursor: pointer; color: #555; transition: all 0.2s ease; padding: 2px; display: flex; align-items: center; justify-content: center; }
                .ai-pin-btn:hover { color: #ffd700; transform: scale(1.15); }
                .ai-pin-btn.active { color: #ffd700; }

                .ai-session-del-btn { background: transparent; border: none; color: #ff4d4d; cursor: pointer; transition: transform 0.1s ease, color 0.2s ease; padding: 2px; display: flex; align-items: center; justify-content: center; }
                .ai-session-del-btn:hover { color: #ff1a1a; }
                .ai-session-del-btn:active { transform: scale(0.85); } 

                .ai-chat-area { flex: 1; display: flex; flex-direction: column; background: transparent; position: relative; }
                .ai-mobile-header { display: none; }
                .ai-messages { flex: 1; overflow-y: auto; padding: 40px; display: flex; flex-direction: column; }
                .ai-empty-state { margin: auto; text-align: center; max-width: 550px; }
                .quick-prompts-container { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
                .quick-prompt { background: #111; border: 1px solid #222; padding: 12px 18px; border-radius: 20px; color: #0abab5; font-size: 14px; font-weight: 800; cursor: pointer; transition: 0.2s; }
                .quick-prompt:hover { background: rgba(10,186,181,0.05); border-color: #0abab5; transform: translateY(-2px); }
                .ai-avatar { width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 20px; }
                .ai-avatar.user { background: #0abab5; color: #000; }
                .ai-avatar.ai { background: #161816; border: 1px solid #333; }
                .ai-bubble { padding: 16px 22px; border-radius: 20px; font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
                .ai-bubble.user { background: rgba(10,186,181,0.1); border: 1px solid rgba(10,186,181,0.3); color: #fff; border-bottom-right-radius: 6px; }
                .ai-bubble.ai { background: #111; border: 1px solid #222; color: #ddd; border-bottom-left-radius: 6px; }
                .ai-input-wrapper { padding: 20px 40px 30px 40px; background: transparent; }
                .ai-input-box { position: relative; display: flex; align-items: flex-end; background: #111; border: 1px solid #222; border-radius: 24px; padding: 6px; transition: 0.2s; }
                .ai-input-box:focus-within { border-color: #0abab5; box-shadow: 0 0 15px rgba(10,186,181,0.1); }
                .ai-textarea { flex: 1; background: transparent; border: none; color: #fff; padding: 16px 20px; font-size: 16px; outline: none; resize: none; max-height: 150px; min-height: 56px; font-family: inherit; }
                .ai-send-btn { margin: 8px; width: 44px; height: 44px; border-radius: 16px; border: none; display: flex; align-items: center; justify-content: center; transition: 0.2s; }
                .ai-send-btn:not(:disabled) { background: #0abab5; color: #000; cursor: pointer; }
                .ai-send-btn:not(:disabled):hover { transform: scale(1.05); }
                .ai-send-btn:disabled { background: #1a1a1a; color: #555; cursor: not-allowed; }
                .ai-footer-text { text-align: center; font-size: 12px; color: #555; margin-top: 12px; }
                .typing-indicator { display: flex; gap: 4px; padding: 2px 0; }
                .typing-indicator span { width: 8px; height: 8px; background: #0abab5; border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both; }
                .typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
                .typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
                .ai-mobile-overlay { display: none; }
                @media (max-width: 768px) {
                    .ai-monolithic-section { margin: -10px -15px -50px -15px; height: calc(100vh - 70px); }
                    .ai-mobile-header { display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; border-bottom: 1px solid #1a1a1a; background: #0a0a0a; }
                    .ai-history-btn { background: rgba(10,186,181,0.1); color: #0abab5; border: 1px solid rgba(10,186,181,0.3); padding: 8px 16px; border-radius: 10px; font-weight: 800; font-size: 13px; transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease, border-color 0.16s ease; }
                    .ai-history-btn:hover { transform: translateY(1px) scale(0.98); box-shadow: inset 0 2px 6px rgba(0,0,0,0.18); background: rgba(10,186,181,0.14); border-color: rgba(10,186,181,0.45); }
                    .ai-history-btn:active { transform: translateY(2px) scale(0.96); box-shadow: inset 0 3px 8px rgba(0,0,0,0.24); }
                    .ai-sidebar { position: fixed; top: 0; left: -300px; width: 280px !important; height: 100vh; background: #000; z-index: 10006; box-shadow: 10px 0 30px rgba(0,0,0,0.8); }
                    .ai-sidebar.open { left: 0; }
                    .ai-mobile-overlay { display: block; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 10005; backdrop-filter: blur(4px); }
                    .ai-messages { padding: 20px 15px; }
                    .ai-input-wrapper { padding: 15px; }
                    .quick-prompt { font-size: 13px; padding: 10px 14px; }
                    .ai-bubble { font-size: 14px; padding: 12px 16px; }
                }
            `}</style>
        </section>
    );
}
