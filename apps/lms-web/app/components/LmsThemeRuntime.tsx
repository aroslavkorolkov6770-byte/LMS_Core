"use client";

import { useEffect } from "react";
import { getPreviewDraft, subscribePreviewDraft } from "../lib/preview-draft-store";

type RgbColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

const NORMALIZED_CLASSES = [
  "lms-light-surface-auto",
  "lms-light-text-auto",
  "lms-light-muted-auto",
  "lms-light-border-auto"
];

function parseColor(value: string | null): RgbColor | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);

  if (hexMatch) {
    const hex = hexMatch[1];
    const expanded = hex.length === 3
      ? hex.split("").map((character) => `${character}${character}`).join("")
      : hex;

    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
      alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1
    };
  }

  const rgbMatch = normalized.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/
  );

  if (!rgbMatch) {
    return null;
  }

  return {
    red: Number(rgbMatch[1]),
    green: Number(rgbMatch[2]),
    blue: Number(rgbMatch[3]),
    alpha: rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4])
  };
}

function getLuminance(color: RgbColor | null): number {
  if (!color) {
    return 0;
  }

  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function isNeutralColor(color: RgbColor): boolean {
  return Math.max(color.red, color.green, color.blue) - Math.min(color.red, color.green, color.blue) <= 18;
}

function removeNormalizedClasses(): void {
  document.querySelectorAll<HTMLElement>(`.${NORMALIZED_CLASSES.join(", .")}`).forEach((element) => {
    element.classList.remove(...NORMALIZED_CLASSES);
  });
}

function normalizeLightElement(element: HTMLElement): void {
  if (element.closest(".lms-home-visual")) {
    return;
  }

  const backgroundColor = parseColor(element.style.backgroundColor);
  const backgroundImage = element.style.backgroundImage.trim().toLowerCase();
  const hasBackgroundImage = Boolean(
    backgroundImage &&
    backgroundImage !== "none" &&
    backgroundImage !== "initial" &&
    backgroundImage !== "inherit" &&
    backgroundImage !== "unset"
  );

  if (
    backgroundColor &&
    backgroundColor.alpha >= 0.98 &&
    getLuminance(backgroundColor) < 0.075 &&
    !hasBackgroundImage
  ) {
    element.classList.add("lms-light-surface-auto");
  }

  const textColor = parseColor(element.style.color);

  if (textColor && isNeutralColor(textColor)) {
    const textLuminance = getLuminance(textColor);

    if (textLuminance >= 0.58) {
      element.classList.add("lms-light-text-auto");
    } else if (textLuminance >= 0.06) {
      element.classList.add("lms-light-muted-auto");
    }
  }

  const borderColor = parseColor(element.style.borderColor);

  if (borderColor && borderColor.alpha >= 0.7 && getLuminance(borderColor) < 0.08) {
    element.classList.add("lms-light-border-auto");
  }
}

function normalizeLightTree(root: ParentNode): void {
  if (root instanceof HTMLElement) {
    normalizeLightElement(root);
  }

  root.querySelectorAll<HTMLElement>("*").forEach(normalizeLightElement);
}

function pickLightSurface(value: string | null, fallback: string): string {
  const color = parseColor(value);
  return color && getLuminance(color) >= 0.5 ? value as string : fallback;
}

function pickLightText(value: string | null, fallback: string): string {
  const color = parseColor(value);
  return color && getLuminance(color) <= 0.42 ? value as string : fallback;
}

export default function LmsThemeRuntime(): null {
  useEffect(() => {
    let observer: MutationObserver | null = null;
    let normalizationTimer = 0;
    let previousLight: boolean | undefined;
    const applyTheme = () => {
      const searchParams = new URLSearchParams(window.location.search);
      const draft = searchParams.get("previewEditable") === "1" ? getPreviewDraft(searchParams.get("previewClientId")) : null;
      if (draft) {
        Object.entries(draft.settings.theme).forEach(([name, value]) => searchParams.set(`preview${name[0].toUpperCase()}${name.slice(1)}`, value));
      }
      const background = searchParams.get("previewBackground") ?? "#0d0f0d";
      const isLightTheme = getLuminance(parseColor(background)) >= 0.58;
      const themeTargetElements = [document.documentElement, document.body];
      const variables: Record<string, string> = {
        "--lms-theme-background": isLightTheme ? pickLightSurface(background, "#f3f6f7") : background,
        "--lms-theme-surface": isLightTheme
          ? pickLightSurface(searchParams.get("previewSurface"), "#ffffff")
          : searchParams.get("previewSurface") ?? "#161816",
        "--lms-theme-surface-soft": isLightTheme ? "#eef3f4" : "#111111",
        "--lms-theme-surface-muted": isLightTheme ? "#e2e9eb" : "#1a1a1a",
        "--lms-theme-text": isLightTheme
          ? pickLightText(searchParams.get("previewText"), "#182329")
          : searchParams.get("previewText") ?? "#ffffff",
        "--lms-theme-muted": isLightTheme
          ? pickLightText(searchParams.get("previewMuted"), "#5b6970")
          : searchParams.get("previewMuted") ?? "#a7b1b7",
        "--lms-theme-border": isLightTheme ? "#cbd6d9" : searchParams.get("previewBorder") ?? "#2b3236",
        "--lms-theme-primary": searchParams.get("previewPrimary") ?? "#0abab5",
        "--lms-theme-accent": searchParams.get("previewAccent") ?? "#6ee7d8",
        "--lms-theme-button": searchParams.get("previewButton") ?? "#0abab5",
        "--lms-theme-button-text": searchParams.get("previewButtonText") ?? "#081015"
      };

      themeTargetElements.forEach((element) => {
        const scheme = isLightTheme ? "light" : "dark";
        if (element.dataset.lmsTheme !== scheme) element.dataset.lmsTheme = scheme;
        Object.entries(variables).forEach(([name, value]) => { if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value); });
      });

      // Changing an accent is not a reason to scan the whole LMS tree again.
      if (previousLight === isLightTheme) return;
      previousLight = isLightTheme;
      window.clearTimeout(normalizationTimer);
      observer?.disconnect();
      observer = null;
      if (!isLightTheme) {
        removeNormalizedClasses();
        return;
      }

      // Suspense-страницы гидратируются позже layout. Не меняем их className,
      // пока React не завершит первый клиентский рендер.
      normalizationTimer = window.setTimeout(() => {
        normalizeLightTree(document.body);

        observer = new MutationObserver((records) => {
          records.forEach((record) => {
            record.addedNodes.forEach((node) => {
              if (node instanceof HTMLElement) {
                normalizeLightTree(node);
              }
            });
          });
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      }, 500);
    };
    applyTheme();
    const unsubscribe = subscribePreviewDraft(applyTheme);

    return () => {
      unsubscribe();
      window.clearTimeout(normalizationTimer);
      observer?.disconnect();
    };
  }, []);

  return null;
}
