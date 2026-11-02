import { schema } from "@lms-core/db";

export type NotificationResponse = {
  id: string;
  clientId: string;
  userId: string;
  deadlineId: string | null;
  documentId: string | null;
  legacyId: string | null;
  title: string;
  message: string;
  channel: string;
  status: string;
  readAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toNotificationResponse(
  item: typeof schema.notifications.$inferSelect
): NotificationResponse {
  return {
    id: item.id,
    clientId: item.clientId,
    userId: item.userId,
    deadlineId: item.deadlineId,
    documentId: item.documentId,
    legacyId: item.legacyId,
    title: item.title,
    message: item.message,
    channel: item.channel,
    status: item.status,
    readAt: item.readAt,
    createdByUserId: item.createdByUserId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}
