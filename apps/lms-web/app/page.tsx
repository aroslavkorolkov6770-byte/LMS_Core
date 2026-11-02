"use client";
import React, { Suspense, useState, useEffect } from 'react';
import Navigation from '@/app/components/Navigation';
import { getIndustryContent } from '@/app/lib/industry-content';
import { getPreviewElementStyle } from '@/app/lib/preview-element-style';
import { appendPreviewParams } from '@/app/lib/preview-runtime';
import { usePreviewRuntime } from '@/app/lib/use-preview-runtime';
import { useRouter, useSearchParams } from 'next/navigation';

// --- ХЕЛПЕР ДЛЯ ЧТЕНИЯ COOKIES ---
const getAppCookie = (name: string) => {
    try {
    if (typeof document === 'undefined') return null;
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) {
        const raw = parts.pop()?.split(';').shift();
        return raw ? decodeURIComponent(raw) : null;
    }
    } catch (error) {
        console.error('Ошибка чтения cookie:', error);
    }
    return null;
};

const getBrowserStorageValue = (storage: Storage | undefined, key: string) => {
    try {
        return storage?.getItem(key) ?? null;
    } catch (error) {
        console.error(`Ошибка чтения ${key} из хранилища браузера:`, error);
        return null;
    }
};

function HomeContent() {
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const router = useRouter();
  const searchParams = useSearchParams();
  const preview = usePreviewRuntime(searchParams);
  const withPreviewPath = (path: string) => appendPreviewParams(path, searchParams);
  const primary = preview.palette.primary;
  const design = preview.design;
  const buttonColor = design.theme.button;
  const buttonTextColor = design.theme.buttonText;
  const homeTitle = preview.enabled ? design.content.homeTitle : "TEA HUB";
  const homeSubtitle = preview.enabled
    ? design.content.homeSubtitle
    : "Среда для обучения и развития. Ваш путь от новичка до эксперта.";
  const industryContent = getIndustryContent(preview.industryTemplate);
  const baseFeatureCards = preview.enabled
    ? industryContent.featureCards
    : [
        { title: 'База знаний', desc: 'Обучающий материал для изучения и подготовки.' },
        { title: 'Система тестирования', desc: 'В любой момент можно проверить свои знания.' },
        preview.features.aiAssistant
          ? { title: 'AI модуль', desc: 'Персональный AI-контур подключается под клиента автоматически.' }
          : { title: 'Быстрый запуск', desc: 'Базовый пакет с чистым контуром для быстрого старта команды.' }
      ];
  const featureCards = preview.enabled
    ? getFeatureCardsWithOverrides(baseFeatureCards, design.content.homeFeatureCards)
    : baseFeatureCards;
  const getHomeSectionOrderIndex = (section: "hero" | "features") => {
    const sectionIndex = design.layout.homeSectionOrder.indexOf(section);

    if (sectionIndex >= 0) {
      return sectionIndex;
    }

    return section === "hero" ? 0 : 1;
  };
  const orderedFeatureCards = getOrderedFeatureCards(featureCards, design.layout.homeFeatureCardOrder);

  useEffect(() => {
    if (preview.enabled) {
      setIsCheckingAuth(false);
      return;
    }

    try {
        const cookieAuth = getAppCookie('isLoggedIn');
        const localAuth = getBrowserStorageValue(window.localStorage, 'isLoggedIn');
        const sessionAuth = getBrowserStorageValue(window.sessionStorage, 'isLoggedIn');
        const isLoggedIn = cookieAuth === 'true' || localAuth === 'true' || sessionAuth === 'true';

        const cookieRole = getAppCookie('userRole');
        const localRole = getBrowserStorageValue(window.localStorage, 'userRole');
        const sessionRole = getBrowserStorageValue(window.sessionStorage, 'userRole');
        const role = cookieRole || localRole || sessionRole;

        if (isLoggedIn) {
            if (role === 'admin') {
                router.push('/admin');
            } else {
                router.push('/tasks?tab=welcome');
            }
        }
    } catch (error) {
        console.error('Ошибка проверки авторизации на главной странице:', error);
    } finally {
        setIsCheckingAuth(false);
    }
  }, [preview.enabled, router]);

  return (
    <div className="lms-home-page" style={{ minHeight: '100vh', position: 'relative', color: design.theme.text, fontFamily: getFontStack(design.typography.bodyFont), fontSize: design.typography.baseFontSizePx, overflowX: 'hidden' }}>
      
      {/* 1. ФОНОВОЕ ФОТО */}
      <div
        data-preview-editable={preview.enabled ? "home.background" : undefined}
        data-preview-label={preview.enabled ? "Фоновое изображение главной" : undefined}
        data-preview-tab={preview.enabled ? "element" : undefined}
        style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundImage: `url("${design.content.homeBackgroundImageUrl}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        zIndex: 0,
        backgroundColor: '#000'
      }} />
      
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.9) 100%)', zIndex: 1, pointerEvents: 'none' }} />

      <div className="home-content-layer lms-home-visual" style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', minHeight: '100vh', pointerEvents: 'none' }}>
        <Navigation />

        <main className="home-main" style={{ width: '100%', maxWidth: '1200px', margin: '0 auto', padding: '160px 20px 80px 20px', flex: 1, display: 'flex', flexDirection: 'column', pointerEvents: 'auto' }}>
          <section style={{ textAlign: 'center', marginBottom: '100px', animation: 'fadeInUp 1s ease', order: getHomeSectionOrderIndex("hero") }}>
            <div
              className="home-badge"
              data-preview-editable={preview.enabled ? "home.badge" : undefined}
              data-preview-label={preview.enabled ? "Бейдж главной" : undefined}
              data-preview-tab={preview.enabled ? "content" : undefined}
              style={getPreviewElementStyle(design, "home.badge", badgeStyle(primary))}
            >
              {preview.enabled ? design.content.homeBadge : "Мастер Платформа"}
            </div>
            <h1
              data-preview-editable={preview.enabled ? "home.title" : undefined}
              data-preview-label={preview.enabled ? "Главный заголовок" : undefined}
              data-preview-tab={preview.enabled ? "content" : undefined}
              style={getPreviewElementStyle(
                design,
                "home.title",
                getHeroTitleStyle(design.typography.headingFont, design.typography.headingScale, design.theme.text)
              )}
            >
              {preview.enabled ? (
                <>
                  {homeTitle}
                </>
              ) : (
                <>TEA <span style={{ color: primary }}>HUB</span></>
              )}
            </h1>
            <p
              data-preview-editable={preview.enabled ? "home.subtitle" : undefined}
              data-preview-label={preview.enabled ? "Подзаголовок" : undefined}
              data-preview-tab={preview.enabled ? "content" : undefined}
              style={getPreviewElementStyle(design, "home.subtitle", { ...heroSubTitleStyle, color: design.theme.muted })}
            >
              {preview.enabled ? homeSubtitle : <>Среда для обучения и развития. <br/> Ваш путь от новичка до эксперта.</>}
            </p>
            {preview.enabled && design.components.showHomeCta ? (
              <div
                data-preview-editable="home.cta"
                data-preview-label="CTA-кнопка"
                data-preview-tab="layout"
                style={getPreviewElementStyle(design, "home.cta", {
                  display: 'flex',
                  justifyContent:
                    design.layout.homeCtaAlign === 'left'
                      ? 'flex-start'
                      : design.layout.homeCtaAlign === 'right'
                        ? 'flex-end'
                        : 'center',
                  marginTop: '22px',
                  transform: `translate(${design.layout.homeCtaOffsetX}px, ${design.layout.homeCtaOffsetY}px)`
                })}
              >
                <a
                  href={withPreviewPath('/tasks?tab=welcome')}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '50px',
                    padding: '0 28px',
                    borderRadius: `${design.typography.buttonRadiusPx}px`,
                    background: buttonColor,
                    color: buttonTextColor,
                    fontFamily: getFontStack(design.typography.buttonFont),
                    fontSize: design.typography.buttonFontSizePx,
                    fontWeight: '900',
                    letterSpacing: '0.03em',
                    textDecoration: 'none',
                    boxShadow: design.components.buttonShadow ? `0 16px 34px ${buttonColor}33` : 'none'
                  }}
                >
                  {design.content.primaryCtaLabel}
                </a>
              </div>
            ) : null}
            {isCheckingAuth && (
                <p style={authCheckTextStyle(primary)}>Проверяем вход...</p>
            )}
          </section>

          <section
            className="home-features"
            data-preview-editable={preview.enabled ? "home.features" : undefined}
            data-preview-label={preview.enabled ? "Карточки преимуществ" : undefined}
            data-preview-tab={preview.enabled ? "layout" : undefined}
            style={getPreviewElementStyle(design, "home.features", { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: `${design.layout.sectionGapPx}px`, marginBottom: '100px', order: getHomeSectionOrderIndex("features") })}
          >
              {orderedFeatureCards.map((box, i) => (
                  <div key={i} style={{ ...infoBoxStyle, borderRadius: `${design.layout.cardRadiusPx}px` }}>
                      <h3 style={{ fontSize: '22px', fontWeight: '800', margin: '0 0 10px 0', color: '#fff' }}>{box.title}</h3>
                      <p style={{ color: '#ccc', lineHeight: '1.6', fontSize: '15px', margin: 0 }}>{box.desc}</p>
                  </div>
              ))}
          </section>
        </main>
      </div>

      <style jsx global>{`
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
        
        body { 
            margin: 0; 
            padding: 0; 
            background: #000; 
            overflow-x: hidden; 
            overflow-y: auto !important;
            width: 100vw;
        }

        * { box-sizing: border-box; }

        .home-content-layer .guest-header,
        .home-content-layer .sidebar-toggle-fixed,
        .home-content-layer .nav-sidebar,
        .home-content-layer .nav-topbar,
        .home-content-layer .home-main {
            pointer-events: auto;
        }

        .custom-scroll::-webkit-scrollbar { width: 4px; }
        .custom-scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }

        @media (max-width: 768px) {
            .home-main { padding: 120px 15px 50px 15px !important; }
            .home-features { grid-template-columns: 1fr !important; gap: 15px !important; }
            .home-badge { white-space: normal !important; height: auto !important; line-height: 1.5 !important; }
        }
      `}</style>
    </div>
  );
}

export default function Home() {
    return (
        <Suspense fallback={null}>
            <HomeContent />
        </Suspense>
    );
}

// --- СТИЛИ ---
const heroSubTitleStyle = { color: '#aaa', fontSize: '19px', maxWidth: '750px', margin: '0 auto', lineHeight: '1.6' };
const authCheckTextStyle = (color: string) => ({ color, fontSize: '13px', fontWeight: '800', marginTop: '18px', textTransform: 'uppercase' as any, letterSpacing: '1px' });
const badgeStyle = (color: string) => ({ display: 'inline-block', background: 'rgba(255,255,255,0.05)', color, padding: '8px 20px', borderRadius: '50px', fontSize: '11px', fontWeight: '800', textTransform: 'uppercase' as any, letterSpacing: '1.5px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(10px)', marginBottom: '20px' });
const infoBoxStyle = { background: 'rgba(20,20,20,0.6)', padding: '50px 40px', borderRadius: '40px', border: '1px solid rgba(255,255,255,0.05)', backdropFilter: 'blur(15px)', textAlign: 'center' as any, transition: '0.3s ease' };

function getFontStack(fontName: string): string {
  return `${fontName}, Inter, Arial, sans-serif`;
}

function getOrderedFeatureCards<T>(cards: T[], order: number[]): T[] {
  const normalizedOrder = order.filter((index) => index >= 0 && index < cards.length);

  cards.forEach((_, index) => {
    if (!normalizedOrder.includes(index)) {
      normalizedOrder.push(index);
    }
  });

  return normalizedOrder.map((index) => cards[index]);
}

type HomeFeatureCard = {
  title: string;
  desc: string;
};

function getFeatureCardsWithOverrides(
  cards: HomeFeatureCard[],
  overrides: HomeFeatureCard[]
): HomeFeatureCard[] {
  return cards.map((card, index) => {
    const override = overrides[index];

    return {
      title: override?.title?.trim() || card.title,
      desc: override?.desc?.trim() || card.desc
    };
  });
}

function getHeroTitleStyle(fontName: string, headingScale: number, color: string): React.CSSProperties {
  const safeScale = Number.isFinite(headingScale) ? Math.max(0.7, Math.min(1.6, headingScale)) : 1;

  return {
    fontFamily: getFontStack(fontName),
    fontSize: `clamp(${Math.round(34 * safeScale)}px, ${Math.round(8 * safeScale)}vw, ${Math.round(92 * safeScale)}px)`,
    fontWeight: '900',
    color,
    margin: '20px 0',
    lineHeight: '1',
    letterSpacing: '-2px'
  };
}
