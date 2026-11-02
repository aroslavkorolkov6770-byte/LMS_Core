import type { Metadata } from "next";
import "./globals.css";
import CookieBanner from "./components/CookieBanner";
import Footer from "./components/Footer";
import PreviewRuntimeBridge from "./components/PreviewRuntimeBridge";
import LmsThemeRuntime from "./components/LmsThemeRuntime";

export const metadata: Metadata = {
  title: "LMS Core",
  description: "Локальная LMS-платформа клиента",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black",
    title: "LMS Core",
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru" suppressHydrationWarning style={{ overscrollBehavior: 'none' }}>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black" />
        {/* ФИКС ДЛЯ МОБИЛОК: предотвращает зум и сдвиги экрана */}
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0" />
      </head>
      {/* ФИКС: Запрещаем горизонтальную прокрутку на уровне всего приложения */}
      <body style={{ backgroundColor: '#0d0f0d', overscrollBehavior: 'none', overflowX: 'hidden', margin: 0, padding: 0 }}>
        <LmsThemeRuntime />
        {children}
        <PreviewRuntimeBridge />
        <Footer />
        <CookieBanner />
      </body>
    </html>
  );
}
