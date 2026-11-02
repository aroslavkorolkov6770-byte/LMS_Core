import { schema } from "@lms-core/db";

export type DeadlineResponse = {
  id: string;
  clientId: string;
  userId: string;
  courseId: string | null;
  testId: string | null;
  title: string;
  status: string;
  dueAt: Date;
  completedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toDeadlineResponse(
  item: typeof schema.deadlines.$inferSelect
): DeadlineResponse {
  return {
    id: item.id,
    clientId: item.clientId,
    userId: item.userId,
    courseId: item.courseId,
    testId: item.testId,
    title: item.title,
    status: item.status,
    dueAt: item.dueAt,
    completedAt: item.completedAt,
    createdByUserId: item.createdByUserId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}
