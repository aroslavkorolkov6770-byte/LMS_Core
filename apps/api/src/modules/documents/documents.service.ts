import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { DocumentFilesService } from "../document-files/document-files.service";
import { CreateDocumentDto } from "./dto/create-document.dto";
import { DocumentMutationDto } from "./dto/document-mutation.dto";
import { LegacySyncDocumentsDto } from "./dto/legacy-sync-documents.dto";
import { ListDocumentsDto } from "./dto/list-documents.dto";
import { UpdateDocumentDto } from "./dto/update-document.dto";
import { DocumentResponse, toDocumentResponse } from "./documents.presenter";

type NormalizedLegacyDocument = {
  title: string;
  slug: string;
  description: string;
  storagePath: string | null;
  mimeType: string;
  isPublished: boolean;
};

@Injectable()
export class DocumentsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService,
    private readonly documentFilesService: DocumentFilesService
  ) {}

  async listDocumentsForActor(
    query: ListDocumentsDto,
    actor: RequestUser
  ): Promise<{ items: DocumentResponse[] }> {
    try {
      const limit = query.limit ?? 20;
      const effectiveClientId =
        actor.roleCode === ROLE_CODES.clientAdmin ? actor.clientId : query.clientId;

      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        query.clientId &&
        query.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot read documents from another client");
      }

      if (effectiveClientId) {
        const items = await this.databaseService.db
          .select()
          .from(schema.documents)
          .where(eq(schema.documents.clientId, effectiveClientId))
          .orderBy(desc(schema.documents.createdAt))
          .limit(limit);

        return { items: items.map(toDocumentResponse) };
      }

      const items = await this.databaseService.db
        .select()
        .from(schema.documents)
        .orderBy(desc(schema.documents.createdAt))
        .limit(limit);

      return { items: items.map(toDocumentResponse) };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load documents", {
        cause: error
      });
    }
  }

  async createDocumentForActor(
    payload: CreateDocumentDto,
    actor: RequestUser
  ): Promise<{ item: DocumentResponse }> {
    try {
      this.assertCanManageClient(payload.clientId, actor);
      await this.assertClientExists(payload.clientId);
      await this.assertSlugIsAvailable(payload.clientId, payload.slug);

      const [item] = await this.databaseService.db
        .insert(schema.documents)
        .values({
          clientId: payload.clientId,
          title: payload.title,
          slug: payload.slug,
          description: payload.description,
          storagePath: payload.storagePath,
          mimeType: payload.mimeType,
          source: "manual",
          isPublished: payload.isPublished ?? false,
          createdByUserId: await this.getExistingActorUserId(actor.userId)
        })
        .returning();

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "document.created",
        entityType: "document",
        entityId: item.id,
        details: {
          title: item.title,
          slug: item.slug,
          source: item.source,
          isPublished: item.isPublished
        }
      });

      return { item: toDocumentResponse(item) };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to create document", {
        cause: error
      });
    }
  }

  async updateDocumentForActor(
    documentId: string,
    payload: UpdateDocumentDto,
    actor: RequestUser
  ): Promise<{ item: DocumentResponse }> {
    try {
      this.assertCanManageClient(payload.clientId, actor);
      const existing = await this.getDocumentOrThrow(documentId, payload.clientId);
      const [item] = await this.databaseService.db
        .update(schema.documents)
        .set({
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.storagePath === undefined ? {} : { storagePath: payload.storagePath }),
          ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
          ...(payload.isPublished === undefined ? {} : { isPublished: payload.isPublished }),
          updatedAt: new Date()
        })
        .where(eq(schema.documents.id, existing.id))
        .returning();

      if (
        payload.storagePath !== undefined &&
        existing.storagePath !== payload.storagePath
      ) {
        await this.deletePrivateFileIfPresent(existing.storagePath, payload.clientId, actor);
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "document.updated",
        entityType: "document",
        entityId: item.id,
        details: {
          slug: item.slug,
          source: item.source,
          isPublished: item.isPublished
        }
      });

      return { item: toDocumentResponse(item) };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to update document", {
        cause: error
      });
    }
  }

  async deleteDocumentForActor(
    documentId: string,
    query: DocumentMutationDto,
    actor: RequestUser
  ): Promise<{ deleted: boolean }> {
    try {
      this.assertCanManageClient(query.clientId, actor);
      const existing = await this.getDocumentOrThrow(documentId, query.clientId);

      await this.databaseService.db
        .delete(schema.documents)
        .where(eq(schema.documents.id, existing.id));
      await this.deletePrivateFileIfPresent(existing.storagePath, query.clientId, actor);
      await this.auditService.writeLog({
        clientId: query.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "document.deleted",
        entityType: "document",
        entityId: existing.id,
        details: {
          slug: existing.slug,
          source: existing.source
        }
      });

      return { deleted: true };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to delete document", {
        cause: error
      });
    }
  }

  async syncLegacyForActor(
    payload: LegacySyncDocumentsDto,
    actor: RequestUser
  ): Promise<{
    total: number;
    documents: number;
    created: number;
    updated: number;
    deleted: number;
    ignoredNonDocuments: number;
  }> {
    try {
      this.assertCanManageClient(payload.clientId, actor);
      await this.assertClientExists(payload.clientId);

      if (!Array.isArray(payload.items)) {
        throw new BadRequestException("items must be an array");
      }

      const normalizedBySlug = new Map<string, NormalizedLegacyDocument>();

      for (const value of payload.items) {
        const normalized = this.normalizeLegacyDocument(value);

        if (normalized) {
          normalizedBySlug.set(normalized.slug, normalized);
        }
      }

      const normalizedItems = Array.from(normalizedBySlug.values());
      const existingItems = await this.databaseService.db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.clientId, payload.clientId));
      const existingBySlug = new Map(existingItems.map((item) => [item.slug, item]));
      const incomingSlugs = new Set(normalizedItems.map((item) => item.slug));
      const actorUserId = await this.getExistingActorUserId(actor.userId);
      let created = 0;
      let updated = 0;
      const deletedDocuments: Array<typeof schema.documents.$inferSelect> = [];

      await this.databaseService.db.transaction(async (tx) => {
        for (const item of normalizedItems) {
          const existing = existingBySlug.get(item.slug);

          if (existing) {
            await tx
              .update(schema.documents)
              .set({
                title: item.title,
                description: item.description,
                storagePath: item.storagePath,
                mimeType: item.mimeType,
                source: "lms_legacy",
                isPublished: item.isPublished,
                updatedAt: new Date()
              })
              .where(eq(schema.documents.id, existing.id));
            updated += 1;
            continue;
          }

          await tx.insert(schema.documents).values({
            clientId: payload.clientId,
            title: item.title,
            slug: item.slug,
            description: item.description,
            storagePath: item.storagePath,
            mimeType: item.mimeType,
            source: "lms_legacy",
            isPublished: item.isPublished,
            createdByUserId: actorUserId
          });
          created += 1;
        }

        for (const existing of existingItems) {
          if (existing.source !== "lms_legacy" || incomingSlugs.has(existing.slug)) {
            continue;
          }

          await tx.delete(schema.documents).where(eq(schema.documents.id, existing.id));
          deletedDocuments.push(existing);
        }
      });

      for (const deletedDocument of deletedDocuments) {
        await this.deletePrivateFileIfPresent(
          deletedDocument.storagePath,
          payload.clientId,
          actor
        );
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId,
        action: "documents.legacy_synced",
        entityType: "documents",
        entityId: payload.clientId,
        details: {
          total: payload.items.length,
          documents: normalizedItems.length,
          created,
          updated,
          deleted: deletedDocuments.length,
          ignoredNonDocuments: payload.items.length - normalizedItems.length
        }
      });

      return {
        total: payload.items.length,
        documents: normalizedItems.length,
        created,
        updated,
        deleted: deletedDocuments.length,
        ignoredNonDocuments: payload.items.length - normalizedItems.length
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync legacy documents", {
        cause: error
      });
    }
  }

  getMeta(): {
    module: string;
    status: string;
    scopedRoute: string;
  } {
    return {
      module: "documents",
      status: "active",
      scopedRoute: "/api/documents/scoped"
    };
  }

  private normalizeLegacyDocument(value: unknown): NormalizedLegacyDocument | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const item = value as Record<string, unknown>;
    const slug = this.asNonEmptyString(item.id);
    const title = this.asNonEmptyString(item.name);

    if (
      item.isDocPlaceholder === true ||
      item.isTest === true ||
      slug?.startsWith("deadline_") ||
      !slug ||
      !title ||
      slug.length > 240
    ) {
      return null;
    }

    const explicitStoragePath = this.asNonEmptyString(item.storagePath);
    const hasSeparateData = item.hasSeparateData === true;

    return {
      title,
      slug,
      description: this.asNonEmptyString(item.section) ?? "Основной раздел",
      storagePath: explicitStoragePath ?? (hasSeparateData ? `file_data_${slug}` : null),
      mimeType: this.asNonEmptyString(item.mimeType) ?? "application/octet-stream",
      isPublished: item.isPublished === false ? false : true
    };
  }

  private assertCanManageClient(clientId: string, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.employee) {
      throw new ForbiddenException("Employee cannot manage documents");
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && actor.clientId !== clientId) {
      throw new ForbiddenException("Client admin cannot manage another client documents");
    }
  }

  private async assertClientExists(clientId: string): Promise<void> {
    const [client] = await this.databaseService.db
      .select({ id: schema.clients.id })
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId))
      .limit(1);

    if (!client) {
      throw new NotFoundException("Client not found");
    }
  }

  private async assertSlugIsAvailable(clientId: string, slug: string): Promise<void> {
    const [existing] = await this.databaseService.db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(
        and(eq(schema.documents.clientId, clientId), eq(schema.documents.slug, slug))
      )
      .limit(1);

    if (existing) {
      throw new BadRequestException("Document with this slug already exists in the client");
    }
  }

  private async getDocumentOrThrow(
    documentId: string,
    clientId: string
  ): Promise<typeof schema.documents.$inferSelect> {
    const [document] = await this.databaseService.db
      .select()
      .from(schema.documents)
      .where(
        and(eq(schema.documents.id, documentId), eq(schema.documents.clientId, clientId))
      )
      .limit(1);

    if (!document) {
      throw new NotFoundException("Document not found in the client");
    }

    return document;
  }

  private async deletePrivateFileIfPresent(
    storagePath: string | null,
    clientId: string,
    actor: RequestUser
  ): Promise<void> {
    if (!storagePath?.startsWith("file_data_")) {
      return;
    }

    const fileKey = storagePath.slice("file_data_".length);

    if (!fileKey) {
      return;
    }

    await this.documentFilesService.deleteForActor({ clientId, fileKey }, actor);
  }

  private asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") {
      return undefined;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private async getExistingActorUserId(
    value: string | null | undefined
  ): Promise<string | undefined> {
    if (!value) {
      return undefined;
    }

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      return undefined;
    }

    const [user] = await this.databaseService.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, value))
      .limit(1);

    return user?.id;
  }
}
