import { schema } from "@lms-core/db";

export type DocumentResponse = {
  id: string;
  clientId: string;
  title: string;
  slug: string;
  description: string | null;
  storagePath: string | null;
  mimeType: string | null;
  source: string;
  isPublished: boolean;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toDocumentResponse(
  document: typeof schema.documents.$inferSelect
): DocumentResponse {
  return {
    id: document.id,
    clientId: document.clientId,
    title: document.title,
    slug: document.slug,
    description: document.description,
    storagePath: document.storagePath,
    mimeType: document.mimeType,
    source: document.source,
    isPublished: document.isPublished,
    createdByUserId: document.createdByUserId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };
}
