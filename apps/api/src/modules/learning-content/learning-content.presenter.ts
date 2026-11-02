import { schema } from "@lms-core/db";

export type LegacyLearningRouteItem = {
  id: string;
  title: string;
  time: string;
  section: string;
  mediaType?: string;
  videoIframe?: string;
  videoDesc?: string;
  h1?: string;
  t1?: string;
  img1?: string;
  h2?: string;
  t2?: string;
  img2?: string;
  h3?: string;
  t3?: string;
  img3?: string;
  isPlaceholder?: boolean;
};

export type LegacyLearningTestItem = {
  id: string;
  title: string;
  subtitle: string;
  theory: string;
  section: string;
  timeLimit: number;
  quiz: Array<{
    q: string;
    o: string[];
    c: number;
  }>;
  isPlaceholder?: boolean;
};

type CourseRow = typeof schema.courses.$inferSelect;
type TestRow = typeof schema.tests.$inferSelect;

export function courseToLegacyRouteItem(course: CourseRow): LegacyLearningRouteItem {
  const content = asRecord(course.content);

  return {
    id: asString(content.id) ?? course.slug,
    title: asString(content.title) ?? course.title,
    time: asString(content.time) ?? formatMinutes(course.estimatedMinutes),
    section: asString(content.section) ?? "Основной раздел",
    mediaType: asString(content.mediaType),
    videoIframe: asString(content.videoIframe),
    videoDesc: asString(content.videoDesc),
    h1: asString(content.h1) ?? course.title,
    t1: asString(content.t1) ?? course.description ?? "",
    img1: asString(content.img1),
    h2: asString(content.h2),
    t2: asString(content.t2),
    img2: asString(content.img2),
    h3: asString(content.h3),
    t3: asString(content.t3),
    img3: asString(content.img3),
    isPlaceholder: content.isPlaceholder === true
  };
}

export function testToLegacyTestItem(test: TestRow): LegacyLearningTestItem {
  const content = asRecord(test.content);
  const quiz = Array.isArray(content.quiz)
    ? content.quiz.map(normalizeQuizQuestion).filter((item): item is LegacyLearningTestItem["quiz"][number] => Boolean(item))
    : [];

  return {
    id: asString(content.id) ?? test.slug,
    title: asString(content.title) ?? test.title,
    subtitle: asString(content.subtitle) ?? test.description ?? "",
    theory: asString(content.theory) ?? "",
    section: asString(content.section) ?? "Основной раздел",
    timeLimit: asPositiveInteger(content.timeLimit) ?? test.timeLimitMinutes ?? 0,
    quiz,
    isPlaceholder: content.isPlaceholder === true
  };
}

export function isArchivedLegacyContent(content: unknown): boolean {
  return asRecord(content).isArchivedByLegacySync === true;
}

function normalizeQuizQuestion(value: unknown): LegacyLearningTestItem["quiz"][number] | null {
  const item = asRecord(value);
  const question = asString(item.q) ?? "Контрольный вопрос";
  const options = Array.isArray(item.o)
    ? item.o.map((option) => String(option ?? "")).filter(Boolean)
    : [];

  if (options.length === 0) {
    return null;
  }

  return {
    q: question,
    o: options,
    c: asPositiveInteger(item.c) ?? 0
  };
}

function formatMinutes(value: number | null): string {
  return value && value > 0 ? `${value} мин` : "5 мин";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue < 0) {
    return undefined;
  }

  return numberValue;
}
