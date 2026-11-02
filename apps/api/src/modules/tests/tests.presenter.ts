import { schema } from "@lms-core/db";

export type TestResponse = {
  id: string;
  clientId: string;
  courseId: string | null;
  title: string;
  slug: string;
  description: string | null;
  contentKind: string;
  content: unknown;
  passingScore: number;
  timeLimitMinutes: number | null;
  orderIndex: number;
  isPublished: boolean;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toTestResponse(test: typeof schema.tests.$inferSelect): TestResponse {
  return {
    id: test.id,
    clientId: test.clientId,
    courseId: test.courseId,
    title: test.title,
    slug: test.slug,
    description: test.description,
    contentKind: test.contentKind,
    content: test.content,
    passingScore: test.passingScore,
    timeLimitMinutes: test.timeLimitMinutes,
    orderIndex: test.orderIndex,
    isPublished: test.isPublished,
    createdByUserId: test.createdByUserId,
    createdAt: test.createdAt,
    updatedAt: test.updatedAt
  };
}
