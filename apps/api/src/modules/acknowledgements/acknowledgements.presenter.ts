import { schema } from "@lms-core/db";

export type AcknowledgementResponse = {
  id: string;
  clientId: string;
  userId: string;
  documentId: string;
  comment: string | null;
  acknowledgedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export function toAcknowledgementResponse(
  item: typeof schema.acknowledgements.$inferSelect
): AcknowledgementResponse {
  return {
    id: item.id,
    clientId: item.clientId,
    userId: item.userId,
    documentId: item.documentId,
    comment: item.comment,
    acknowledgedAt: item.acknowledgedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}
