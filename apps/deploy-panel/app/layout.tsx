import type { ReactElement, ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";
import "../../control-center/renderer/palettes.css";
import "./core-workspace.css";
import { CoreAppearance } from "./core-appearance";

export const metadata: Metadata = {
  title: "LMS Core Панель деплоя",
  description: "Локальная панель подготовки и развертывания LMS Core"
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>): ReactElement {
  return (
    <html lang="ru" data-scroll-behavior="smooth">
      <body><CoreAppearance />{children}</body>
    </html>
  );
}
