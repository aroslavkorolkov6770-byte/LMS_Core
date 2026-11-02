"use client";

import React from "react";

type LearningLinkedTextProps = {
  text: string;
  onOpenRoute: (routeId: string) => void;
  onOpenTest: (testId: string) => void;
  style?: React.CSSProperties;
};

type TextToken = {
  href?: string;
  label: string;
};

const LINK_PATTERN = /\[([^\]]+)]\(([^)\s]+)\)|(https?:\/\/[^\s]+|\/tasks\?[^\s]+)/g;
const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

const tokenizeText = (text: string): TextToken[] => {
  const tokens: TextToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) {
      tokens.push({ label: text.slice(cursor, matchIndex) });
    }

    const markdownLabel = match[1];
    const markdownHref = match[2];
    const plainHref = match[3];
    const href = markdownHref || plainHref;
    const cleanHref = plainHref ? plainHref.replace(TRAILING_PUNCTUATION, "") : href;
    const trailingText = plainHref ? plainHref.slice(cleanHref.length) : "";

    tokens.push({
      href: cleanHref,
      label: markdownLabel || cleanHref,
    });

    if (trailingText) {
      tokens.push({ label: trailingText });
    }

    cursor = matchIndex + match[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ label: text.slice(cursor) });
  }

  return tokens;
};

export default function LearningLinkedText({
  text,
  onOpenRoute,
  onOpenTest,
  style,
}: LearningLinkedTextProps) {
  const tokens = tokenizeText(text || "");

  const handleLinkClick = (
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    try {
      const destination = new URL(href, window.location.href);
      const isCurrentLms = destination.origin === window.location.origin;
      const routeId = destination.searchParams.get("routeId");
      const testId = destination.searchParams.get("testId");

      if (isCurrentLms && routeId) {
        event.preventDefault();
        onOpenRoute(routeId);
        return;
      }

      if (isCurrentLms && testId) {
        event.preventDefault();
        onOpenTest(testId);
      }
    } catch (error) {
      event.preventDefault();
      console.error("Не удалось открыть ссылку учебного материала", error);
    }
  };

  return (
    <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...style }}>
      {tokens.map((token, index) => {
        if (!token.href) {
          return <React.Fragment key={`text-${index}`}>{token.label}</React.Fragment>;
        }

        return (
          <a
            key={`link-${index}`}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => handleLinkClick(event, token.href as string)}
            style={{
              color: "#0abab5",
              fontWeight: 800,
              textDecoration: "underline",
              textUnderlineOffset: "3px",
            }}
          >
            {token.label}
          </a>
        );
      })}
    </span>
  );
}
