"use client";
import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type DocType = 'processing' | 'privacy' | 'terms' | 'cookies';

const sections: Array<{
  id: DocType;
  navLabel: string;
  title: string;
  meta: string;
  blocks: Array<
    | { kind: 'text'; title: string; text: string }
    | { kind: 'list'; title: string; intro?: string; items: string[] }
  >;
}> = [
  {
    id: 'processing',
    navLabel: 'Обработка персональных данных',
    title: 'Согласие на обработку персональных данных',
    meta: 'Действует с момента активации аккаунта пользователем',
    blocks: [
      {
        kind: 'text',
        title: '1. Что включает в себя согласие',
        text:
          'Принимая условия настоящего соглашения при активации учетной записи на платформе TEA HUB, пользователь свободно, своей волей и в своем интересе выражает безоговорочное согласие на обработку своих персональных данных Администрацией платформы.',
      },
      {
        kind: 'list',
        title: '2. Перечень обрабатываемых данных',
        intro: 'Для обеспечения учебного процесса и авторизации в системе обработке подлежат следующие данные:',
        items: [
          'Фамилия, Имя, Отчество для формирования личного профиля.',
          'Адрес электронной почты для системных уведомлений.',
          'Идентификатор мессенджера Telegram для оперативной связи.',
          'Номер контактного телефона.',
          'Статистика успеваемости, логи авторизации и результаты прохождения тестирований.',
        ],
      },
      {
        kind: 'text',
        title: '3. Цели обработки данных',
        text:
          'Персональные данные пользователей обрабатываются исключительно в целях предоставления доступа к базе знаний, контроля прохождения учебных курсов, проведения аттестаций стажеров и бариста, а также предотвращения несанкционированного доступа к конфиденциальной информации компании через систему TeaGuard.',
      },
    ],
  },
  {
    id: 'privacy',
    navLabel: 'Политика конфиденциальности',
    title: 'Политика конфиденциальности',
    meta: 'Редакция от 2026 года',
    blocks: [
      {
        kind: 'text',
        title: '1. Общие положения',
        text:
          'Настоящая Политика определяет порядок обработки и защиты информации о физических лицах, пользующихся услугами и материалами образовательной платформы TEA HUB. Безопасность данных пользователей является для нас приоритетом.',
      },
      {
        kind: 'text',
        title: '2. Безопасность и защита данных',
        text:
          'Персональные данные хранятся на защищенных серверах. Для защиты рабочих профилей и журналов активности используются организационные и технические меры безопасности, направленные на предотвращение утечки, перехвата и несанкционированного изменения информации.',
      },
      {
        kind: 'text',
        title: '3. Передача третьим лицам',
        text:
          'Администрация платформы TEA HUB не передает, не продает и не раскрывает персональные, контактные или статистические данные сотрудников сторонним рекламным сервисам и третьим лицам, если иное прямо не требуется применимым законодательством или внутренними обязательствами работодателя.',
      },
    ],
  },
  {
    id: 'terms',
    navLabel: 'Пользовательское соглашение',
    title: 'Пользовательское соглашение',
    meta: 'Внутренний регламент использования платформы',
    blocks: [
      {
        kind: 'text',
        title: '1. Условия использования платформы',
        text:
          'Платформа TEA HUB является закрытым внутренним корпоративным ресурсом. Доступ к платформе предоставляется сотрудникам, стажерам и руководящему составу исключительно для выполнения учебных задач, ознакомления со стандартами сервиса и матрицей ассортимента.',
      },
      {
        kind: 'text',
        title: '2. Обязанности пользователя',
        text:
          'Пользователь обязуется соблюдать конфиденциальность учетных данных и не передавать свой логин и пароль третьим лицам. Любая попытка копирования, скачивания или распространения учебных материалов за пределы компании рассматривается как нарушение внутреннего режима доступа к информации.',
      },
      {
        kind: 'text',
        title: '3. Ответственность',
        text:
          'В случае выявления фактов передачи аккаунта третьим лицам или умышленного распространения базы знаний администрация оставляет за собой право ограничить доступ к учетной записи и применить предусмотренные внутренними документами меры реагирования.',
      },
    ],
  },
  {
    id: 'cookies',
    navLabel: 'Соглашение с файлами cookie',
    title: 'Соглашение об использовании файлов cookie',
    meta: 'Технический регламент работы сессий',
    blocks: [
      {
        kind: 'text',
        title: '1. Что такое файлы cookie',
        text:
          'Cookie — это небольшие текстовые файлы, которые сохраняются на устройстве пользователя при посещении сайта. Они помогают поддерживать сеанс, хранить выбранные параметры и обеспечивать стабильную работу интерфейса.',
      },
      {
        kind: 'list',
        title: '2. Как cookie используются в TEA HUB',
        intro: 'На платформе файлы cookie и связанные сессии используются только в служебных целях:',
        items: [
          'Сохранение состояния авторизации, чтобы не вводить пароль заново при переходе между разделами.',
          'Поддержка пользовательской сессии и локальных настроек интерфейса.',
          'Сохранение технических идентификаторов, необходимых для изолированной истории в ИИ Помощнике.',
        ],
      },
      {
        kind: 'text',
        title: '3. Отказ от cookie',
        text:
          'Если пользователь выбирает вариант «НЕТ (только на сеанс)» в баннере, данные сохраняются только в пределах текущей сессии браузера. После закрытия вкладки или выхода из учетной записи эти временные данные удаляются автоматически.',
      },
    ],
  },
];

export default function PrivacyPage() {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<DocType>('processing');
  const sectionRefs = useRef<Record<DocType, HTMLElement | null>>({
    processing: null,
    privacy: null,
    terms: null,
    cookies: null,
  });

  const syncSectionFromLocation = (behavior: ScrollBehavior) => {
    const params = new URLSearchParams(window.location.search);
    const requestedDoc = params.get('doc') as DocType | null;
    const targetId = requestedDoc && sectionRefs.current[requestedDoc] ? requestedDoc : 'processing';
    const scrollTarget = sectionRefs.current[targetId];

    setActiveSection(targetId);

    if (scrollTarget) {
      const top = scrollTarget.getBoundingClientRect().top + window.scrollY - 24;
      window.scrollTo({ top, behavior });
    }
  };

  useEffect(() => {
    window.requestAnimationFrame(() => {
      syncSectionFromLocation('auto');
    });

    const handleLocationChange = () => syncSectionFromLocation('auto');
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);

    return () => {
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
    };
  }, []);

  useEffect(() => {
    const onScroll = () => {
      const entries = sections.map(({ id }) => {
        const node = sectionRefs.current[id];
        if (!node) return { id, top: Number.POSITIVE_INFINITY };
        const { top } = node.getBoundingClientRect();
        return { id, top: Math.abs(top - 140) };
      });

      const closest = entries.sort((a, b) => a.top - b.top)[0];
      if (closest) {
        setActiveSection(closest.id);
      }
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const openSection = (id: DocType) => {
    router.replace(`/privacy?doc=${id}#${id}`, { scroll: false });
    setActiveSection(id);
    const target = sectionRefs.current[id];
    if (target) {
      const top = target.getBoundingClientRect().top + window.scrollY - 24;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  };

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.push('/');
  };

  return (
    <div style={pageWrapper}>
      <div style={backgroundOverlay} />
      <div style={backgroundShade} />

      <div style={layoutShell} className="privacy-layout">
        <aside style={sidebarStyle} className="privacy-sidebar">
          <button onClick={handleBack} style={backBtnStyle} className="back-btn">
            Вернуться назад
          </button>

          <div style={sidebarTitleArea}>
            <p style={eyebrowStyle}>Документы</p>
            <h1 style={sidebarTitle}>Юридическая и сервисная информация</h1>
            <p style={sidebarNote}>
              Документы открываются сразу в нужном разделе и подходят для просмотра с телефона и компьютера.
            </p>
          </div>

          <nav style={navStyle}>
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => openSection(section.id)}
                className={`menu-item ${activeSection === section.id ? 'active' : ''}`}
                style={{
                  ...menuItemStyle,
                  color: activeSection === section.id ? '#fff' : '#95a19b',
                  background: activeSection === section.id ? 'rgba(11, 28, 24, 0.92)' : 'transparent',
                  borderColor: activeSection === section.id ? 'rgba(10, 186, 181, 0.45)' : 'rgba(255,255,255,0.08)',
                }}
              >
                {section.navLabel}
              </button>
            ))}
          </nav>
        </aside>

        <main style={contentAreaStyle}>
          <section style={heroSectionStyle}>
            <p style={eyebrowStyle}>TEA HUB</p>
            <h2 style={heroTitleStyle}>Политика, согласия и условия использования</h2>
            <p style={heroTextStyle}>
              На этой странице каждый документ открывается как отдельный смысловой блок, поэтому ссылка из футера или формы ведет сразу к нужному тексту.
            </p>
          </section>

          <div style={documentSurfaceStyle}>
            {sections.map((section) => (
              <section
                key={section.id}
                id={section.id}
                ref={(node) => {
                  sectionRefs.current[section.id] = node;
                }}
                style={docSectionStyle}
                className="privacy-doc-section"
              >
                <div style={sectionHeaderStyle}>
                  <p style={sectionMetaStyle}>{section.meta}</p>
                  <h3 style={contentTitle}>{section.title}</h3>
                </div>

                <div style={sectionBodyStyle}>
                  {section.blocks.map((block) => (
                    <div key={`${section.id}-${block.title}`} style={contentBlockStyle}>
                      <h4 style={subTitle}>{block.title}</h4>
                      {block.kind === 'text' ? (
                        <p style={textBlock}>{block.text}</p>
                      ) : (
                        <>
                          {block.intro ? <p style={textBlock}>{block.intro}</p> : null}
                          <ul style={listStyle}>
                            {block.items.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>

      <style jsx global>{`
        html {
          scroll-behavior: smooth;
        }

        @keyframes privacyFadeUp {
          from {
            opacity: 0;
            transform: translateY(16px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .menu-item {
          transition: all 0.2s ease !important;
        }

        .menu-item:hover {
          color: #ffffff !important;
          border-color: rgba(10, 186, 181, 0.25) !important;
          background: rgba(255, 255, 255, 0.03) !important;
        }

        .privacy-doc-section {
          animation: privacyFadeUp 0.35s ease forwards;
        }

        .back-btn:hover {
          background: #0abab5 !important;
          color: #032321 !important;
          border-color: #0abab5 !important;
        }

        @media (max-width: 980px) {
          .privacy-layout {
            grid-template-columns: 1fr !important;
            gap: 24px !important;
          }

          .privacy-sidebar {
            position: static !important;
            top: auto !important;
          }
        }

        @media (max-width: 720px) {
          .privacy-doc-section {
            padding: 28px 20px !important;
          }
        }
      `}</style>
    </div>
  );
}

// --- СТИЛИ КОМПОНЕНТА ---
const pageWrapper: React.CSSProperties = {
  minHeight: '100vh',
  position: 'relative',
  padding: '24px',
  boxSizing: 'border-box',
  overflowX: 'hidden',
  backgroundColor: '#000',
};

const backgroundOverlay: React.CSSProperties = {
  position: 'absolute',
  top: 0, left: 0, right: 0, bottom: 0,
  backgroundImage: 'url("https://u.9111s.ru/uploads/202402/17/a0254a12ef37da5aaf5c5646a30baab8.webp")',
  backgroundSize: 'cover',
  backgroundPosition: 'center center',
  zIndex: -2,
};

const backgroundShade: React.CSSProperties = {
  position: 'absolute',
  top: 0, left: 0, right: 0, bottom: 0,
  background: 'linear-gradient(180deg, rgba(3, 10, 8, 0.9) 0%, rgba(6, 8, 7, 0.96) 100%)',
  zIndex: -1,
};

const layoutShell: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '320px minmax(0, 1fr)',
  gap: '32px',
  width: '100%',
  maxWidth: '1380px',
  margin: '0 auto',
  boxSizing: 'border-box',
};

const sidebarStyle: React.CSSProperties = {
  position: 'sticky',
  top: '24px',
  alignSelf: 'start',
  background: 'rgba(8, 13, 12, 0.88)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '28px',
  padding: '28px',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  backdropFilter: 'blur(18px)',
};

const backBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '14px 16px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#d8e0dc',
  borderRadius: '16px',
  fontSize: '14px',
  fontWeight: '800',
  cursor: 'pointer',
  transition: '0.2s ease',
  marginBottom: '28px',
};

const sidebarTitleArea: React.CSSProperties = {
  marginBottom: '24px',
};

const eyebrowStyle: React.CSSProperties = {
  margin: '0 0 10px 0',
  color: '#0abab5',
  fontSize: '12px',
  fontWeight: '800',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
};

const sidebarTitle: React.CSSProperties = {
  margin: 0,
  color: '#fff',
  fontSize: '28px',
  fontWeight: '900',
  lineHeight: '1.12',
};

const sidebarNote: React.CSSProperties = {
  margin: '14px 0 0 0',
  color: '#92a09a',
  fontSize: '14px',
  lineHeight: '1.55',
};

const navStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

const menuItemStyle: React.CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '16px 18px',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px',
  fontSize: '14px',
  fontWeight: '700',
  cursor: 'pointer',
  lineHeight: '1.3',
  boxSizing: 'border-box',
};

const contentAreaStyle: React.CSSProperties = {
  minWidth: 0,
  boxSizing: 'border-box',
};

const heroSectionStyle: React.CSSProperties = {
  padding: '18px 0 26px 0',
};

const heroTitleStyle: React.CSSProperties = {
  margin: 0,
  color: '#fff',
  fontSize: 'clamp(32px, 4vw, 56px)',
  fontWeight: '900',
  lineHeight: '1.02',
  maxWidth: '760px',
};

const heroTextStyle: React.CSSProperties = {
  margin: '18px 0 0 0',
  color: '#a9b6b1',
  fontSize: '16px',
  lineHeight: '1.7',
  maxWidth: '760px',
};

const documentSurfaceStyle: React.CSSProperties = {
  background: 'rgba(9, 13, 12, 0.76)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '28px',
  backdropFilter: 'blur(14px)',
  overflow: 'hidden',
};

const docSectionStyle: React.CSSProperties = {
  padding: '40px 42px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  scrollMarginTop: '24px',
};

const sectionHeaderStyle: React.CSSProperties = {
  marginBottom: '24px',
};

const sectionMetaStyle: React.CSSProperties = {
  margin: '0 0 12px 0',
  color: '#6f817b',
  fontSize: '12px',
  fontWeight: '800',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const sectionBodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '24px',
};

const contentBlockStyle: React.CSSProperties = {
  maxWidth: '880px',
};

const contentTitle: React.CSSProperties = {
  margin: 0,
  color: '#fff',
  fontSize: 'clamp(24px, 2vw, 34px)',
  fontWeight: '900',
  lineHeight: '1.3',
};

const subTitle: React.CSSProperties = {
  color: '#0abab5',
  fontSize: '17px',
  fontWeight: '900',
  margin: '0 0 12px 0',
};

const textBlock: React.CSSProperties = {
  color: '#d8dfdb',
  fontSize: '15px',
  lineHeight: '1.75',
  margin: 0,
};

const listStyle: React.CSSProperties = {
  color: '#d8dfdb',
  fontSize: '15px',
  lineHeight: '1.8',
  paddingLeft: '20px',
  margin: '12px 0 0 0',
};
