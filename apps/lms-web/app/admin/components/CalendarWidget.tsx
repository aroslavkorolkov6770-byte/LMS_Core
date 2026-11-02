"use client";
import React from 'react';
import { adminCard, sectionTitle, dateBox, calNavBtn, calendarGrid, calDayHead } from './adminStyles';

const MONTH_NAMES = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const DAYS_OF_WEEK = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

export default function CalendarWidget({
    eventTab, setEventTab, filteredEvents, currentDate, handlePrevMonth, handleNextMonth,
    daysInMonth, shiftStartDay, isToday, openNotePanel, notes
}: any) {
    return (
        <aside className="calendar-widget" style={{ display: 'flex', flexDirection: 'column', gap: '30px', minWidth: 0 }}>
            <div className="calendar-events-card" style={{ ...adminCard, padding: '20px' } as any}>
                <h2 className="admin-section-title" style={{ ...sectionTitle, fontSize: '18px', margin: '0 0 15px 0' } as any}>Ближайшие события</h2>
                
                <div className="calendar-tabs" style={{ position: 'relative', display: 'flex', background: '#111', borderRadius: '25px', padding: '4px', marginBottom: '15px', border: '1px solid #222' }}>
                    <div style={{ 
                        position: 'absolute', top: '4px', bottom: '4px', left: '4px', width: 'calc(50% - 4px)', 
                        background: eventTab === 'personal' ? '#0abab5' : '#ff4d4d', borderRadius: '20px', 
                        transition: '0.3s cubic-bezier(0.4, 0, 0.2, 1)', transform: eventTab === 'personal' ? 'translateX(0)' : 'translateX(100%)'
                    }} />
                    <div onClick={() => setEventTab('personal')} style={{ position: 'relative', zIndex: 1, flex: 1, textAlign: 'center', padding: '8px', cursor: 'pointer', color: eventTab === 'personal' ? '#000' : '#888', fontWeight: '900', fontSize: '12px', transition: '0.3s' }}>ЗАМЕТКИ</div>
                    <div onClick={() => setEventTab('deadline')} style={{ position: 'relative', zIndex: 1, flex: 1, textAlign: 'center', padding: '8px', cursor: 'pointer', color: eventTab === 'deadline' ? '#000' : '#888', fontWeight: '900', fontSize: '12px', transition: '0.3s' }}>ДЕДЛАЙНЫ</div>
                </div>

                <div className="custom-scroll" style={{ maxHeight: '300px', overflowY: 'auto', paddingRight: '5px' }}>
                    {filteredEvents.length === 0 ? (
                        <div style={{ color: '#555', fontSize: '13px', textAlign: 'center', padding: '20px 0', fontWeight: 'bold' }}>Нет записей</div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {filteredEvents.slice(0, 10).map((event: any) => (
                                <div key={event.key} className="calendar-event-item" style={{ display: 'flex', gap: '15px', alignItems: 'center', padding: '12px', background: '#0d0d0d', borderRadius: '15px', border: `1px solid ${eventTab === 'deadline' ? 'rgba(255,77,77,0.2)' : 'rgba(10,186,181,0.1)'}` }}>
                                    <div style={{ ...dateBox, background: eventTab === 'deadline' ? '#ff4d4d' : '#0abab5' } as any}>
                                        {event.d} <br/> <span style={{ fontSize: '10px', opacity: 0.8 }}>{DAYS_OF_WEEK[event.dateObj.getDay()]}</span>
                                    </div>
                                    <div style={{ flex: 1, overflow: 'hidden' }}>
                                        <div style={{ fontWeight: '800', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#fff' }}>{event.title}</div>
                                        {eventTab === 'deadline' ? (
                                            <div style={{ fontSize: '11px', color: '#ff4d4d', marginTop: '4px', fontWeight: 'bold' }}>Кому: {event.target}</div>
                                        ) : (
                                            event.desc && <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{event.desc}</div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div className="calendar-month-card" style={adminCard as any}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
                    <span style={{ fontWeight: '900', fontSize: '18px' }}>{MONTH_NAMES[currentDate.getMonth()]} {currentDate.getFullYear()}</span>
                    <div style={{ display: 'flex', gap: '15px' }}>
                        <span onClick={handlePrevMonth} style={calNavBtn as any}>←</span>
                        <span onClick={handleNextMonth} style={calNavBtn as any}>→</span>
                    </div>
                </div>
                <div style={calendarGrid as any}>
                    {['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => <div key={d} style={calDayHead as any}>{d}</div>)}
                    {Array.from({length: shiftStartDay}).map((_, i) => <div key={`empty-${i}`} />)}
                    
                    {Array.from({length: daysInMonth}).map((_, i) => {
                        const dayNumber = i + 1;
                        const dateKey = `${currentDate.getFullYear()}-${currentDate.getMonth()}-${dayNumber}`;
                        const noteTextStr = notes[dateKey];
                        const hasNote = !!noteTextStr;
                        const isDeadlineNote = hasNote && noteTextStr.startsWith('[Дедлайн:');
                        const isTdy = isToday(dayNumber);
                        return (
                            <div key={dayNumber} className={`cal-day ${isTdy ? 'today' : ''}`} onClick={() => openNotePanel(dayNumber)}>
                                <span>{dayNumber}</span>
                                {hasNote && <div className={`note-dot ${isDeadlineNote ? 'deadline-dot' : ''}`} />}
                            </div>
                        )
                    })}
                </div>
            </div>
        </aside>
    );
}
