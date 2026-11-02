"use client";
import React, { Suspense, useState, useEffect } from 'react';
import Navigation from '@/app/components/Navigation';
import CustomIcon from '@/app/components/CustomIcon';
import { getPreviewElementStyle } from '@/app/lib/preview-element-style';
import { usePreviewRuntime } from '@/app/lib/use-preview-runtime';
import { fetchStorageBatch, saveDataToServer } from '@/app/lib/storageClient';
import { useSearchParams } from 'next/navigation';

import UserManagement from './components/UserManagement';
import StatisticsPanel from './components/StatisticsPanel';
import InteractionCenter from './components/InteractionCenter';
import CalendarWidget from './components/CalendarWidget';
import UserProfileModal from './components/UserProfileModal';
import TestEditorModal from './components/TestEditorModal';
import TestResultsModal from './components/TestResultsModal';

import { noteOverlayStyle, noteSidebarStyle, noteTextarea, noteDeleteBtn, adminSendBtn, flexSpace, sectionTitle, adminIn, saveBtn, modalOverlay, modalContentSmall } from './components/adminStyles';

const MONTH_NAMES = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

function AdminDashboardContent() {
  const searchParams = useSearchParams();
  const preview = usePreviewRuntime(searchParams);
  const design = preview.design;
  const [isMounted, setIsMounted] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(!preview.enabled);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pushStatus, setPushStatus] = useState<'default' | 'granted' | 'denied' | 'unsupported'>('granted');

  const [users, setUsers] = useState<any[]>([]);
  const [userAvatars, setUserAvatars] = useState<Record<string, string>>({});
  const [userProfiles, setUserProfiles] = useState<Record<string, any>>({});
  const [urgentFiles, setUrgentFiles] = useState<any[]>([]);
  const [testResults, setTestResults] = useState<any[]>([]);
  const [usersStats, setUsersStats] = useState<Record<string, {route: number, basics: number}>>({});
  const [totalBasicsModules, setTotalBasicsModules] = useState(50);
  const [totalRouteSteps, setTotalRouteSteps] = useState(5);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteType, setNoteType] = useState<'personal' | 'deadline'>('personal');
  const [deadlineTarget, setDeadlineTarget] = useState<string>('Все');
  const [eventTab, setEventTab] = useState<'personal' | 'deadline'>('personal');

  const [dynamicTests, setDynamicTests] = useState<any[]>([]);
  const [linkedTestId, setLinkedTestId] = useState<string>("");
  
  const [testSearchQuery, setTestSearchQuery] = useState("");
  const [showTestDropdown, setShowTestDropdown] = useState(false);

  const [testTypesList, setTestTypesList] = useState<any[]>([{ id: 't1', name: ' Итоговая аттестация' }, { id: 't2', name: ' Переаттестация' }]);
  const [interactionTab, setInteractionTab] = useState<'notif' | 'test'>('notif');
  const [selectedStaff, setSelectedStaff] = useState("Все");
  const [notifText, setNotifText] = useState("");
  const [testType, setTestType] = useState('');
  
  const [selectedProfileUser, setSelectedProfileUser] = useState<any>(null);
  const [editAuthMode, setEditAuthMode] = useState(false);
  const [editAuthLogin, setEditAuthLogin] = useState('');
  const [editAuthPass, setEditAuthPass] = useState('');

  const [showTestEditor, setShowTestEditor] = useState(false);
  const [testFormData, setTestFormData] = useState({ title: '', timeLimit: 0, quiz: [{ q: '', o: ['', '', '', ''], c: 0 }] });
  const [showTestModal, setShowTestModal] = useState(false);
  const [selectedTestUser, setSelectedTestUser] = useState("Все");

  const [showSuccessModal, setShowSuccessModal] = useState<{show: boolean, title: string, text: string}>({ show: false, title: '', text: '' });
  const [errorModal, setErrorModal] = useState({ show: false, text: '' });

  useEffect(() => {
    setIsMounted(true);
    const handleSidebarState = (event: Event) => {
      const customEvent = event as CustomEvent<{ open?: boolean }>;
      setIsSidebarOpen(customEvent.detail?.open === true);
    };
    window.addEventListener('sidebarStateChange', handleSidebarState);

    if (typeof window !== 'undefined') {
        if (!('Notification' in window)) setPushStatus('unsupported');
        else setPushStatus(Notification.permission as any);
    }

    const loadAllData = async () => {
        try {
            const storageData = await fetchStorageBatch([
                'admin_cal_notes_v1',
                'core_lms_users_v1',
                'core_lms_test_results_v1',
                'core_lms_documents_v1',
                'core_lms_route_v1',
                'core_lms_test_types_v1',
                'core_lms_tests_v1',
            ]);

            const notesData = storageData['admin_cal_notes_v1'];
            if (notesData && !Array.isArray(notesData)) setNotes(notesData);

            let usersData = storageData['core_lms_users_v1'];
            if (!Array.isArray(usersData) || usersData.length === 0) {
                usersData = [{ id: 'u_admin', login: '11', pass: '11', role: 'admin', name: 'Главный Мастер' }];
                saveDataToServer('core_lms_users_v1', usersData);
            }
            setUsers(usersData);

            const testData = storageData['core_lms_test_results_v1'];
            setTestResults(Array.isArray(testData) ? testData : []);

            const filesData = storageData['core_lms_documents_v1'];
            if (Array.isArray(filesData)) setUrgentFiles(filesData);

            const typesData = storageData['core_lms_test_types_v1'];
            if (Array.isArray(typesData) && typesData.length > 0) setTestTypesList(typesData);

            const loadedTests = storageData['core_lms_tests_v1'];
            const dynamicRouteData = storageData['core_lms_route_v1'];

            if (Array.isArray(loadedTests)) {
                setDynamicTests(loadedTests);
            }

            setTotalBasicsModules(Array.isArray(loadedTests) ? loadedTests.length : 0);
            setTotalRouteSteps(Array.isArray(dynamicRouteData) ? dynamicRouteData.length : 5);

            const stats: Record<string, {route: number, basics: number}> = {};
            const avatarsFound: Record<string, string> = {};
            const profilesFound: Record<string, any> = {};
            const profileKeys = usersData.map((u: any) => `profile_data_${u.id}`);
            const staffUsers = usersData.filter((u: any) => u.role === 'staff');
            const progressKeys = staffUsers.flatMap((u: any) => [`prog_route_${u.id}`, `prog_tests_${u.id}`]);
            const relatedData = await fetchStorageBatch([...profileKeys, ...progressKeys]);

            for (const u of usersData) {
                if (u.avatar) avatarsFound[u.id] = u.avatar;

                const profData = relatedData[`profile_data_${u.id}`];
                if (profData && !Array.isArray(profData)) {
                    profilesFound[u.id] = profData;
                    if (profData.avatar) avatarsFound[u.id] = profData.avatar;
                }

                if (u.role === 'staff') {
                    const uRouteData = relatedData[`prog_route_${u.id}`];
                    const uTestsData = relatedData[`prog_tests_${u.id}`];
                    stats[u.id] = {
                        route: Array.isArray(uRouteData) ? uRouteData.length : 0,
                        basics: Array.isArray(uTestsData) ? uTestsData.length : 0,
                    };
                }
            }

            setUsersStats(stats);
            setUserAvatars(avatarsFound);
            setUserProfiles(profilesFound);

        } catch (error) { console.error("Error", error); }
    };

    loadAllData();
    return () => window.removeEventListener('sidebarStateChange', handleSidebarState);
  }, []);

  const handleUpdateTestTypes = (newTypes: any[]) => {
      setTestTypesList(newTypes);
      saveDataToServer('core_lms_test_types_v1', newTypes);
  };

  useEffect(() => {
      if (testTypesList.length > 0 && !testTypesList.some(t => t.name === testType)) {
          setTestType(testTypesList[0].name);
      }
  }, [testTypesList, testType]);

  useEffect(() => {
      if (testType) {
          setTestFormData({ 
              title: testType, 
              timeLimit: 0, 
              quiz: [
                  { q: 'Какой водой заваривать зеленый чай?', o: ['100°C', '75-80°C', '60°C', '40°C'], c: 1 }, 
                  { q: 'Что такое Гайвань?', o: ['Чайник', 'Чашка с крышкой', 'Поднос', 'Лопатка'], c: 1 }, 
                  { q: 'Какая скрутка у Те Гуань Инь?', o: ['Продольная', 'Сферическая', 'Прессованная', 'Сломанная'], c: 1 }
              ] 
          });
      }
  }, [testType]);

  const subscribeToPush = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          return setErrorModal({ show: true, text: "Браузер не поддерживает Web Push уведомления." });
      }
      
      const currentId = localStorage.getItem('current_user_id') || 'guest';
      if (currentId === 'guest' || !currentId) {
          return setErrorModal({ show: true, text: "Перед включением уведомлений нужно войти в аккаунт!" });
      }
      
      try {
          const permission = await Notification.requestPermission();
          setPushStatus(permission);
          
          if (permission === 'granted') {
              const swUrl = `/sw.js?v=${Date.now()}`;
              const registration = await navigator.serviceWorker.register(swUrl);
              let subscription = await registration.pushManager.getSubscription();
              
              if (!subscription) {
                  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
                  if (!vapidPublicKey) {
                      return setErrorModal({ show: true, text: "Ошибка: VAPID ключ не найден в конфигурации!" });
                  }
                  const urlBase64ToUint8Array = (base64String: string) => {
                      const padding = '='.repeat((4 - base64String.length % 4) % 4);
                      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
                      const rawData = window.atob(base64);
                      const outputArray = new Uint8Array(rawData.length);
                      for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
                      return outputArray;
                  };
                  subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
              }
              
              const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_push_subscriptions_v1`);
              let subs = await res.json().catch(() => []);
              if (!Array.isArray(subs)) subs = [];
              
              if (!subs.find((s: any) => s.sub.endpoint === subscription?.endpoint)) {
                  subs.push({ userId: currentId, sub: subscription });
                  saveDataToServer('core_lms_push_subscriptions_v1', subs);
                  setShowSuccessModal({ show: true, title: 'ПОДПИСКА ОФОРМЛЕНА', text: "Устройство успешно привязано к вашему аккаунту и готово получать уведомления." });
              } else {
                  setShowSuccessModal({ show: true, title: 'УЖЕ ПОДПИСАНЫ', text: "Это устройство уже успешно зарегистрировано в системе." });
              }
          } else {
              setErrorModal({ show: true, text: "Вы заблокировали уведомления в браузере. Разрешите их в настройках сайта." });
          }
      } catch (error: any) { 
          setErrorModal({ show: true, text: `Ошибка подписки: ${error?.message || error}` }); 
      }
  };

  const sendEmailNotification = async (targetUserId: string, subject: string, text: string) => {
      try {
          let emailsToSend: string[] = [];
          if (targetUserId === 'Все') {
              users.filter(u => u.role === 'staff').forEach(u => {
                  const email = userProfiles[u.id]?.email || u.email;
                  if (email) emailsToSend.push(email);
              });
          } else {
              const email = userProfiles[targetUserId]?.email || users.find(u => u.id === targetUserId)?.email;
              if (email) emailsToSend.push(email);
          }
          if (emailsToSend.length === 0) return false;
          const res = await fetch('/api/send-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: emailsToSend.join(', '), subject, text }) });
          return res.ok;
      } catch (e) { return false; }
  };

  const sendPushNotification = async (targetUserId: string, payload: { title: string, body: string, url?: string }) => {
      try {
          const subsRes = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_push_subscriptions_v1`, { cache: 'no-store' });
          const subs = await subsRes.json().catch(() => []);
          if (!Array.isArray(subs) || subs.length === 0) return false;
          const targetSubs = targetUserId === 'Все' ? subs : subs.filter((s: any) => s.userId === targetUserId);
          if (targetSubs.length === 0) return false;
          const apiRes = await fetch('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriptions: targetSubs.map((s: any) => s.sub), payload }) });
          return apiRes.ok;
      } catch (e) { return false; }
  };

  const handleSaveUserAuth = async () => {
      if (!editAuthLogin.trim() || !editAuthPass.trim()) return setErrorModal({ show: true, text: "Логин и пароль не могут быть пустыми!" });
      if (users.find(u => u.login === editAuthLogin.trim() && u.id !== selectedProfileUser.id)) return setErrorModal({ show: true, text: "Логин занят другим пользователем!" });
      const updatedUsers = users.map(u => u.id === selectedProfileUser.id ? { ...u, login: editAuthLogin.trim(), pass: editAuthPass.trim() } : u);
      setUsers(updatedUsers);
      saveDataToServer('core_lms_users_v1', updatedUsers);
      setSelectedProfileUser({ ...selectedProfileUser, login: editAuthLogin.trim(), pass: editAuthPass.trim() });
      setEditAuthMode(false);
      setShowSuccessModal({ show: true, title: 'ДОСТУПЫ ОБНОВЛЕНЫ', text: `Новые данные для входа успешно сохранены.` });
  };

  const handlePrevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  const handleNextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
  const startDayIndex = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1).getDay();
  const shiftStartDay = startDayIndex === 0 ? 6 : startDayIndex - 1;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isToday = (d: number) => today.getDate() === d && today.getMonth() === currentDate.getMonth() && today.getFullYear() === currentDate.getFullYear();
  const formattedSelectedDate = () => selectedDateKey ? `${selectedDateKey.split('-')[2]} ${MONTH_NAMES[parseInt(selectedDateKey.split('-')[1])]} ${selectedDateKey.split('-')[0]}` : "";
  
  const openNotePanel = (day: number) => { 
      const key = `${currentDate.getFullYear()}-${currentDate.getMonth()}-${day}`; 
      setSelectedDateKey(key); 
      setNoteText(notes[key] || ""); 
      setNoteType('personal'); 
      setDeadlineTarget('Все'); 
      setLinkedTestId('');
      setTestSearchQuery('');
  };
  
  const closeNotePanel = () => { 
      setSelectedDateKey(null); 
      setNoteText(""); 
      setLinkedTestId(''); 
      setTestSearchQuery('');
  };

  const saveNote = async () => {
      if (!selectedDateKey) return;
      if (!noteText.trim()) { const newNotes = { ...notes }; delete newNotes[selectedDateKey]; setNotes(newNotes); saveDataToServer('admin_cal_notes_v1', newNotes); closeNotePanel(); return; }
      if (isProcessing) return; setIsProcessing(true);
      try {
          const newNotes = { ...notes };
          let adminNoteText = noteText.trim();
          
          if (noteType === 'deadline') {
              let finalLinkedTestId = linkedTestId;

              if (linkedTestId.startsWith('tpl_')) {
                  const templateName = linkedTestId.replace('tpl_', '');
                  const newDynTest = {
                      id: 't_' + Date.now(),
                      title: templateName,
                      subtitle: 'Аттестация',
                      theory: '',
                      section: 'Аттестации',
                      timeLimit: 0,
                      quiz: getBaseQuizTemplate()
                  };
                  const updatedTests = [...dynamicTests, newDynTest];
                  setDynamicTests(updatedTests);
                  saveDataToServer('core_lms_tests_v1', updatedTests);
                  finalLinkedTestId = newDynTest.id;
              } 
              else if (testSearchQuery.trim() && !linkedTestId) {
                  const newDynTest = {
                      id: 't_' + Date.now(),
                      title: testSearchQuery.trim(),
                      subtitle: 'Индивидуальный тест',
                      theory: '',
                      section: 'Индивидуальные',
                      timeLimit: 0,
                      quiz: getBaseQuizTemplate()
                  };
                  const updatedTests = [...dynamicTests, newDynTest];
                  setDynamicTests(updatedTests);
                  saveDataToServer('core_lms_tests_v1', updatedTests);
                  finalLinkedTestId = newDynTest.id;
              }

              const targetName = deadlineTarget === 'Все' ? 'Всем' : users.find(u => u.id === deadlineTarget)?.name || deadlineTarget;
              adminNoteText = `[Дедлайн: ${targetName}]\n${noteText.trim()}`;
              
              const newDeadlineTask = { 
                  id: 'deadline_' + Date.now(), 
                  name: ' Дедлайн: ' + noteText.trim(),
                  size: 'Выполнить до: ' + formattedSelectedDate(), 
                  date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }), 
                  target: deadlineTarget, 
                  isTest: false,
                  linkedTestId: finalLinkedTestId || null
              };
              
              const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_documents_v1`);
              const currentFiles = await res.json().catch(() => []);
              const updatedFiles = [newDeadlineTask, ...(Array.isArray(currentFiles) ? currentFiles : [])];
              setUrgentFiles(updatedFiles);
              await saveDataToServer('core_lms_documents_v1', updatedFiles);
              
              const pushUrl = finalLinkedTestId ? `/tasks?tab=edu&testId=${finalLinkedTestId}` : '/tasks?tab=edu';
              const pushSent = await sendPushNotification(deadlineTarget, { title: ' Новый дедлайн', body: noteText.trim(), url: pushUrl });
              
              let emailBody = `Вам назначен дедлайн (выполнить до: ${formattedSelectedDate()}).\nЗадача: ${noteText.trim()}`;
              if (finalLinkedTestId) {
                  const tName = dynamicTests.find(t => t.id === finalLinkedTestId)?.title || testSearchQuery.replace('[Аттестация] ', '') || "Тест";
                  emailBody += `\nК задаче прикреплен тест: "${tName}". Откройте платформу для прохождения.`;
              }
              const emailSent = await sendEmailNotification(deadlineTarget, ' Внимание: Новый дедлайн!', emailBody);
              
              setShowSuccessModal({ show: true, title: 'ДЕДЛАЙН НАЗНАЧЕН', text: `Задача сохранена. ${pushSent || emailSent ? '(Уведомления отправлены)' : ''}` });
          }
          
          newNotes[selectedDateKey] = adminNoteText;
          setNotes(newNotes);
          saveDataToServer('admin_cal_notes_v1', newNotes);
      } finally { setIsProcessing(false); closeNotePanel(); }
  };

  const deleteNote = () => { 
      if (!selectedDateKey) return; 
      const newNotes = { ...notes }; 
      delete newNotes[selectedDateKey]; 
      setNotes(newNotes); 
      saveDataToServer('admin_cal_notes_v1', newNotes); 
      closeNotePanel(); 
  };

  const parsedEvents = Object.entries(notes).map(([key, text]) => {
      const [y, m, d] = key.split('-').map(Number);
      const isDeadline = text.startsWith('[Дедлайн:');
      let title = text, desc = '', target = '';
      if (isDeadline) {
          const match = text.match(/\[Дедлайн: (.*?)\]\n?([\s\S]*)/);
          if (match) { target = match[1]; const lines = match[2].split('\n'); title = lines[0] || 'Без названия'; desc = lines.slice(1).join(' '); }
      } else { const lines = text.split('\n'); title = lines[0] || 'Без названия'; desc = lines.slice(1).join(' '); }
      return { key, text, dateObj: new Date(y, m, d), d, isDeadline, target, title, desc };
  }).filter(event => event.dateObj >= (new Date(new Date().setHours(0,0,0,0)))).sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  
  const filteredEvents = parsedEvents.filter(e => eventTab === 'personal' ? !e.isDeadline : e.isDeadline);

  const handleSendNotification = async () => {
      if (!notifText.trim() || isProcessing) return; setIsProcessing(true);
      try {
          const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_notifications_v1`);
          const arr = await res.json().catch(() => []);
          const newNotif = { id: Date.now(), title: selectedStaff === 'Все' ? 'Общее уведомление' : 'Личное сообщение', text: notifText.trim(), time: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }), target: selectedStaff };
          await saveDataToServer('core_lms_notifications_v1', [newNotif, ...(Array.isArray(arr) ? arr : [])]);
          const pushSent = await sendPushNotification(selectedStaff, { title: newNotif.title, body: newNotif.text, url: '/tasks?tab=welcome' });
          const emailSent = await sendEmailNotification(selectedStaff, newNotif.title, newNotif.text);
          if (pushSent || emailSent) setShowSuccessModal({ show: true, title: 'СООБЩЕНИЕ ОТПРАВЛЕНО', text: 'Уведомление доставлено сотрудникам.' });
          setNotifText("");
      } finally { setIsProcessing(false); }
  };

  const getBaseQuizTemplate = () => [{ q: 'Какой водой заваривать зеленый чай?', o: ['100°C', '75-80°C', '60°C', '40°C'], c: 1 }, { q: 'Что такое Гайвань?', o: ['Чайник', 'Чашка с крышкой', 'Поднос', 'Лопатка'], c: 1 }, { q: 'Какая скрутка у Те Гуань Инь?', o: ['Продольная', 'Сферическая', 'Прессованная', 'Сломанная'], c: 1 }];

  const handleOpenTestEditor = () => { setShowTestEditor(true); };

  const handleQuickSendTest = async () => {
      if (isProcessing) return; setIsProcessing(true);
      try {
          const newTestTask = { id: 'test_' + Date.now(), name: testType, timeLimit: 0, size: 'Интерактивный тест', date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }), isTest: true, target: selectedStaff, quiz: getBaseQuizTemplate() };
          const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_documents_v1`);
          const currentFiles = await res.json().catch(() => []);
          const updatedFiles = [newTestTask, ...(Array.isArray(currentFiles) ? currentFiles : [])];
          setUrgentFiles(updatedFiles);
          await saveDataToServer('core_lms_documents_v1', updatedFiles);
          setShowSuccessModal({ show: true, title: 'АТТЕСТАЦИЯ НАЗНАЧЕНА', text: `Тест успешно отправлен.` });
      } finally { setIsProcessing(false); }
  };

  const handleSendTest = async () => {
      if (testFormData.quiz.some(q => !q.q.trim() || q.o.some(opt => !opt.trim()))) return setErrorModal({ show: true, text: 'Все поля должны быть заполнены!' });
      if (isProcessing) return; setIsProcessing(true);
      try {
          const newTestTask = { id: 'test_' + Date.now(), name: testFormData.title, timeLimit: testFormData.timeLimit || 0, size: 'Интерактивный тест', date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }), isTest: true, target: selectedStaff, quiz: testFormData.quiz };
          const res = await fetch(`/api/storage?t=${Date.now()}&key=core_lms_documents_v1`);
          const currentFiles = await res.json().catch(() => []);
          const updatedFiles = [newTestTask, ...(Array.isArray(currentFiles) ? currentFiles : [])];
          setUrgentFiles(updatedFiles);
          await saveDataToServer('core_lms_documents_v1', updatedFiles);
          setShowSuccessModal({ show: true, title: 'АТТЕСТАЦИЯ НАЗНАЧЕНА', text: `Тест "${testFormData.title}" отправлен.` });
          setShowTestEditor(false);
      } finally { setIsProcessing(false); }
  };

  const updateTestQuestion = (index: number, field: string, value: any) => {
      const newQuiz = [...testFormData.quiz];
      if (field === 'q') newQuiz[index].q = value;
      if (field === 'c') newQuiz[index].c = value;
      if (field.startsWith('o')) newQuiz[index].o[parseInt(field.replace('o', ''))] = value;
      setTestFormData({...testFormData, quiz: newQuiz});
  };
  const addTestQuestion = () => setTestFormData({...testFormData, quiz: [...testFormData.quiz, { q: '', o: ['', '', '', ''], c: 0 }]});
  const removeTestQuestion = (index: number) => setTestFormData({...testFormData, quiz: testFormData.quiz.filter((_, i) => i !== index)});

  const allOptions = [
      ...dynamicTests.map(t => ({ id: t.id, title: t.title, type: 'test' })),
      ...testTypesList.map(t => ({ id: 'tpl_' + t.name, title: `[Аттестация] ${t.name}`, type: 'template' }))
  ];

  if (!isMounted) return <div style={{ backgroundColor: '#0d0f0d', minHeight: '100vh', display: 'flex' }}><Suspense fallback={null}><Navigation /></Suspense><div style={{ width: '260px', flexShrink: 0 }} /></div>;

  return (
    <div className="lms-admin-page" style={{ backgroundColor: preview.enabled ? design.theme.background : '#0d0f0d', minHeight: '100vh', color: preview.enabled ? design.theme.text : '#fff', display: 'flex', transition: '0.3s' }}>
      <Suspense fallback={null}>
        <Navigation />
      </Suspense>
      <div className="desktop-sidebar-spacer" style={{ width: isSidebarOpen ? '260px' : '0', transition: '0.3s', flexShrink: 0 }} />

      <main
        className="admin-main"
        data-preview-editable="admin.shell"
        data-preview-label="Рабочая область админки"
        data-preview-tab="layout"
        style={getPreviewElementStyle(design, "admin.shell", { flex: 1, padding: '110px 40px 40px 40px', transition: '0.3s', boxSizing: 'border-box', maxWidth: '100%' })}
      >
          <div style={{ animation: 'fadeInUp 0.4s ease' }}>

            {pushStatus === 'default' && (
                <div style={{ background: '#111', border: '1px solid #0abab5', borderRadius: '18px', padding: '20px', marginBottom: '30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '15px' }}>
                    <div>
                        <h3 style={{ margin: '0 0 5px 0', fontSize: '16px', color: '#0abab5', fontWeight: '900' }}>Включите Web-Push</h3>
                        <p style={{ margin: 0, color: '#aaa', fontSize: '13px' }}>Разрешите получение пушей на этот компьютер.</p>
                    </div>
                    <button onClick={subscribeToPush} style={{ background: '#0abab5', color: '#000', border: 'none', padding: '12px 25px', borderRadius: '12px', fontWeight: '900', cursor: 'pointer', fontSize: '13px' }}>РАЗРЕШИТЬ</button>
                </div>
            )}

            <div className="admin-layout-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 350px', gap: '30px', marginBottom: '30px', marginTop: '40px' }}>
              <section style={{ minWidth: 0 }}>
                
                <UserManagement 
                    users={users} setUsers={setUsers} userAvatars={userAvatars}
                    setShowSuccessModal={setShowSuccessModal} setErrorModal={setErrorModal} setSelectedProfileUser={setSelectedProfileUser}
                />

                <div className="admin-flex-space" style={{ ...flexSpace, marginTop: '40px' } as any}>
                  <h2
                    className="admin-section-title"
                    data-preview-editable="admin.testResults"
                    data-preview-label="Результаты тестов"
                    data-preview-tab="content"
                    style={getPreviewElementStyle(design, "admin.testResults", { ...sectionTitle, cursor: 'pointer', color: '#0abab5', textDecoration: 'underline' } as any)}
                    onClick={() => setShowTestModal(true)}
                  >
                    Результаты тестирования ↗
                  </h2>
                  <span style={{ fontSize: '13px', color: '#666', fontWeight: 'bold' }}>Всего записей: {testResults.length}</span>
                </div>

                <InteractionCenter 
                    users={users} interactionTab={interactionTab} setInteractionTab={setInteractionTab}
                    selectedStaff={selectedStaff} setSelectedStaff={setSelectedStaff} notifText={notifText}
                    setNotifText={setNotifText} testType={testType} setTestType={setTestType}
                    handleSendNotification={handleSendNotification} handleOpenTestEditor={handleOpenTestEditor}
                    handleQuickSendTest={handleQuickSendTest} isProcessing={isProcessing}
                    testTypesList={testTypesList} handleUpdateTestTypes={handleUpdateTestTypes}
                />

              </section>

              <CalendarWidget 
                  eventTab={eventTab} setEventTab={setEventTab} filteredEvents={filteredEvents}
                  currentDate={currentDate} handlePrevMonth={handlePrevMonth} handleNextMonth={handleNextMonth}
                  daysInMonth={daysInMonth} shiftStartDay={shiftStartDay} isToday={isToday}
                  openNotePanel={openNotePanel} notes={notes}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
               <StatisticsPanel 
                   users={users} usersStats={usersStats} totalRouteSteps={totalRouteSteps} 
                   totalBasicsModules={totalBasicsModules} userAvatars={userAvatars} setSelectedProfileUser={setSelectedProfileUser}
               />
            </div>
          </div>
      </main>

      <UserProfileModal 
          selectedProfileUser={selectedProfileUser} setSelectedProfileUser={setSelectedProfileUser}
          userProfiles={userProfiles} usersStats={usersStats} totalRouteSteps={totalRouteSteps}
          totalBasicsModules={totalBasicsModules} userAvatars={userAvatars} testResults={testResults}
          editAuthMode={editAuthMode} setEditAuthMode={setEditAuthMode} editAuthLogin={editAuthLogin}
          setEditAuthLogin={setEditAuthLogin} editAuthPass={editAuthPass} setEditAuthPass={setEditAuthPass}
          handleSaveUserAuth={handleSaveUserAuth}
      />

      {showTestEditor && (
          <TestEditorModal 
              testFormData={testFormData} setTestFormData={setTestFormData} updateTestQuestion={updateTestQuestion}
              removeTestQuestion={removeTestQuestion} addTestQuestion={addTestQuestion} handleSendTest={handleSendTest}
              isProcessing={isProcessing} setShowTestEditor={setShowTestEditor}
          />
      )}

      {showTestModal && (
          <TestResultsModal 
              setShowTestModal={setShowTestModal} selectedTestUser={selectedTestUser}
              setSelectedTestUser={setSelectedTestUser} users={users} testResults={testResults}
          />
      )}

      {selectedDateKey && (
        <div style={noteOverlayStyle as any} onClick={closeNotePanel}>
          <div style={noteSidebarStyle as any} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: '900', color: '#0abab5' }}>ЗАМЕТКА</h2>
              <div onClick={closeNotePanel} style={{ cursor: 'pointer', fontSize: '20px', opacity: 0.5 }}>X</div>
            </div>
            <p style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '20px', color: '#ccc' }}>Дата: {formattedSelectedDate()}</p>
            
            <div style={{ position: 'relative', display: 'flex', background: '#111', borderRadius: '14px', marginBottom: '20px', padding: '4px', border: '1px solid #222' }}>
                <div style={{ position: 'absolute', top: '4px', bottom: '4px', left: noteType === 'personal' ? '4px' : 'calc(50% + 2px)', width: 'calc(50% - 6px)', background: '#222', borderRadius: '10px', transition: '0.3s cubic-bezier(0.4, 0, 0.2, 1)', border: '1px solid #333' }} />
                <div onClick={() => setNoteType('personal')} style={{ position: 'relative', zIndex: 1, flex: 1, textAlign: 'center', padding: '10px', cursor: 'pointer', color: noteType === 'personal' ? '#0abab5' : '#666', fontWeight: '900', fontSize: '13px', transition: '0.3s' }}>Для себя</div>
                <div onClick={() => setNoteType('deadline')} style={{ position: 'relative', zIndex: 1, flex: 1, textAlign: 'center', padding: '10px', cursor: 'pointer', color: noteType === 'deadline' ? '#0abab5' : '#666', fontWeight: '900', fontSize: '13px', transition: '0.3s' }}>Дедлайн</div>
            </div>

            {noteType === 'deadline' && (
                <div style={{ marginBottom: '15px', animation: 'fadeInUp 0.3s ease' }}>
                    <div style={{ fontSize: '12px', color: '#888', fontWeight: 'bold', marginBottom: '8px' }}>Кому назначить:</div>
                    <select style={{ ...adminIn, marginBottom: 0, padding: '12px', cursor: 'pointer' } as any} value={deadlineTarget} onChange={e => setDeadlineTarget(e.target.value)}>
                        <option value="Все">Всем сотрудникам</option>
                        {users.filter(u => u.role === 'staff').map(u => <option key={u.id} value={u.id}>{u.name} ({u.login})</option>)}
                    </select>
                    
                    <div style={{ position: 'relative', marginTop: '15px' }}>
                        <div style={{ fontSize: '12px', color: '#888', fontWeight: 'bold', marginBottom: '8px' }}>Прикрепить тест (найти или создать новый):</div>
                        <input 
                            type="text"
                            style={{ ...adminIn, marginBottom: 0, padding: '12px' } as any}
                            placeholder="Введите название или выберите..."
                            value={testSearchQuery}
                            onChange={(e) => {
                                setTestSearchQuery(e.target.value);
                                setLinkedTestId(''); 
                                setShowTestDropdown(true);
                            }}
                            onFocus={() => setShowTestDropdown(true)}
                            onBlur={() => setTimeout(() => setShowTestDropdown(false), 200)}
                        />
                        {showTestDropdown && (
                            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#111', border: '1px solid #333', borderRadius: '12px', maxHeight: '150px', overflowY: 'auto', zIndex: 1000, marginTop: '5px' }} className="custom-scroll">
                                <div 
                                    onClick={() => { setLinkedTestId(''); setTestSearchQuery(''); setShowTestDropdown(false); }}
                                    style={{ padding: '10px 12px', cursor: 'pointer', fontSize: '13px', color: '#888', borderBottom: '1px solid #222' }}
                                    onMouseEnter={(e) => e.currentTarget.style.color = '#fff'}
                                    onMouseLeave={(e) => e.currentTarget.style.color = '#888'}
                                >
                                     Без теста
                                </div>
                                {allOptions.filter(o => o.title.toLowerCase().includes(testSearchQuery.toLowerCase())).map(opt => (
                                    <div 
                                        key={opt.id}
                                        onClick={() => {
                                            setLinkedTestId(opt.id);
                                            setTestSearchQuery(opt.title.replace('[Аттестация] ', ''));
                                            setShowTestDropdown(false);
                                        }}
                                        style={{ padding: '10px 12px', cursor: 'pointer', fontSize: '13px', color: '#fff', borderBottom: '1px solid #222' }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(10,186,181,0.2)'}
                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                        {opt.title}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            <textarea autoFocus value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder={noteType === 'deadline' ? "Текст задачи..." : "Текст заметки..."} style={{...noteTextarea, height: noteType === 'deadline' ? '135px' : '200px'} as any} />
            <div style={{ display: 'flex', gap: '10px', marginTop: '20px', flexWrap: 'wrap' }}>
                <button onClick={saveNote} disabled={isProcessing} style={{...adminSendBtn, flex: 1, minWidth: '100px', cursor: isProcessing ? 'not-allowed' : 'pointer'} as any}>{isProcessing ? 'СОХРАНЕНИЕ...' : 'СОХРАНИТЬ'}</button>
                {notes[selectedDateKey] && <button onClick={deleteNote} disabled={isProcessing} style={{...noteDeleteBtn, flex: 1, minWidth: '100px', cursor: isProcessing ? 'not-allowed' : 'pointer'} as any}>УДАЛИТЬ</button>}
            </div>
          </div>
        </div>
      )}

      {showSuccessModal.show && (
          <div style={modalOverlay as any} onClick={() => setShowSuccessModal({ ...showSuccessModal, show: false })}>
              <div className="admin-modal-content" style={{ ...modalContentSmall, maxWidth: '420px', padding: '35px', textAlign: 'center' } as any} onClick={e => e.stopPropagation()}>
                  <div style={{ marginBottom: '20px', animation: 'scaleIn 0.3s ease', display: 'flex', justifyContent: 'center' }}><CustomIcon name="success" size={56} color="#0abab5" /></div>
                  <h2 style={{ color: '#0abab5', fontWeight: '900', marginBottom: '15px', textTransform: 'uppercase' }}>{showSuccessModal.title}</h2>
                  <p style={{ color: '#ccc', fontSize: '16px', lineHeight: '1.6', marginBottom: '25px' }}>{showSuccessModal.text}</p>
                  <button onClick={() => setShowSuccessModal({ ...showSuccessModal, show: false })} style={saveBtn as any}>ПОНЯТНО</button>
              </div>
          </div>
      )}

      {errorModal.show && (
          <div style={modalOverlay as any} onClick={() => setErrorModal({ show: false, text: '' })}>
              <div className="admin-modal-content" style={{ ...modalContentSmall, maxWidth: '380px', padding: '35px', textAlign: 'center' } as any} onClick={e => e.stopPropagation()}>
                  <div style={{ width: '60px', height: '60px', borderRadius: '18px', border: '1px solid rgba(255,77,77,0.35)', background: 'rgba(255,77,77,0.08)', color: '#ff4d4d', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px auto' }}><CustomIcon name="alert" size={34} color="#ff4d4d" /></div>
                  <h2 style={{ color: '#ff4d4d', fontWeight: '900', marginBottom: '15px', textTransform: 'uppercase' }}>ОШИБКА</h2>
                  <p style={{ color: '#ccc', fontSize: '15px', lineHeight: '1.5', marginBottom: '25px', wordBreak: 'break-word' }}>{errorModal.text}</p>
                  <button onClick={() => setErrorModal({ show: false, text: '' })} style={{ ...saveBtn, background: '#333', color: '#fff' } as any}>ПОНЯТНО</button>
              </div>
          </div>
      )}

      <style jsx global>{`
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes scaleIn { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        * { box-sizing: border-box; }
        body { overflow-x: hidden; margin: 0; padding: 0; background: #0d0f0d; }

        .cal-day { position: relative; font-size: 13px; padding: 10px 0; border-radius: 12px; font-weight: 800; color: #fff; cursor: pointer; transition: 0.2s ease; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 38px; }
        .cal-day:hover { background: #0abab5; color: #000; }
        .cal-day.today { background: #0abab5; color: #000; }
        .note-dot { position: absolute; bottom: 4px; width: 4px; height: 4px; background: #0abab5; border-radius: 50%; }
        .deadline-dot { background: #ff4d4d; }
        .cal-day:hover .note-dot, .cal-day.today .note-dot { background: #000; }
        
        .keep-scroll::-webkit-scrollbar { width: 6px !important; display: block !important; }
        .keep-scroll::-webkit-scrollbar-thumb { background: #333 !important; border-radius: 10px !important; }
        .keep-scroll { -ms-overflow-style: auto !important; scrollbar-width: thin !important; scrollbar-color: #333 transparent !important; }

        @media (max-width: 768px) {
            .desktop-sidebar-spacer { display: none !important; width: 0 !important; }
            .admin-main { padding: 90px 15px 50px 15px !important; }
            .admin-layout-grid { grid-template-columns: 1fr !important; gap: 20px !important; margin-top: 20px !important; }
            .admin-section-title { font-size: 20px !important; margin-bottom: 20px !important; }
            .admin-flex-space { flex-direction: column; align-items: flex-start !important; gap: 15px !important; margin-bottom: 25px !important; }
            .admin-user-grid { grid-template-columns: 1fr !important; }
            .admin-user-card { flex-direction: column !important; align-items: flex-start !important; gap: 16px !important; padding: 16px !important; border-radius: 20px !important; }
            .admin-user-avatar-col { flex: auto !important; width: 100% !important; margin-bottom: 0 !important; }
            .admin-user-bars-col { border-left: none !important; padding-left: 0 !important; width: 100% !important; border-top: 1px solid #222; padding-top: 16px !important; }
            .admin-user-actions-col { border-left: none !important; padding-left: 0 !important; width: 100% !important; justify-content: flex-end; height: auto !important; border-top: 1px solid #222; padding-top: 16px !important; }
            .admin-user-progress-row { gap: 8px !important; }
            .admin-user-progress-label { width: 56px !important; font-size: 10px !important; }
            .admin-user-progress-value { width: 40px !important; font-size: 12px !important; }
            .interaction-center-tabs { flex-direction: column; }
            .interaction-center-tabs > div { border-left: none !important; border-bottom: 1px solid #222; }
            .interaction-center-row { flex-direction: column; align-items: stretch !important; gap: 15px !important; }
            .interaction-center-label { width: 100% !important; margin-bottom: -5px; }
            .admin-modal-content { padding: 30px 20px !important; width: 95% !important; border-radius: 25px !important; }
        }
      `}</style>
    </div>
  );
}

export default function AdminDashboard() {
  return (
    <Suspense fallback={null}>
      <AdminDashboardContent />
    </Suspense>
  );
}
