import { schema } from "@lms-core/db";

export type ProgressResponse = {
  id: string;
  clientId: string;
  userId: string;
  courseId: string;
  lastTestId: string | null;
  status: string;
  completionPercent: number;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toProgressResponse(
  item: typeof schema.progress.$inferSelect
): ProgressResponse {
  return {
    id: item.id,
    clientId: item.clientId,
    userId: item.userId,
    courseId: item.courseId,
    lastTestId: item.lastTestId,
    status: item.status,
    completionPercent: item.completionPercent,
    completedAt: item.completedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}
