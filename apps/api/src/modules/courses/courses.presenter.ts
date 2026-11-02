import { schema } from "@lms-core/db";

export type CourseResponse = {
  id: string;
  clientId: string;
  title: string;
  slug: string;
  description: string | null;
  contentKind: string;
  content: unknown;
  roleLabel: string | null;
  estimatedMinutes: number | null;
  orderIndex: number;
  isPublished: boolean;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toCourseResponse(course: typeof schema.courses.$inferSelect): CourseResponse {
  return {
    id: course.id,
    clientId: course.clientId,
    title: course.title,
    slug: course.slug,
    description: course.description,
    contentKind: course.contentKind,
    content: course.content,
    roleLabel: course.roleLabel,
    estimatedMinutes: course.estimatedMinutes,
    orderIndex: course.orderIndex,
    isPublished: course.isPublished,
    createdByUserId: course.createdByUserId,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt
  };
}
