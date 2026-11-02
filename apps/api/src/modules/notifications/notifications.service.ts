import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, desc, eq, isNotNull, notInArray } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { CreateNotificationDto } from "./dto/create-notification.dto";
import {
  LegacyListNotificationsDto,
  LegacyNotificationItem,
  LegacySyncNotificationsDto
} from "./dto/legacy-notifications.dto";
import { ListNotificationsDto } from "./dto/list-notifications.dto";
import { NotificationResponse, toNotificationResponse } from "./notifications.presenter";

@Injectable()
export class NotificationsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listNotificationsForActor(
    query: ListNotificationsDto,
    actor: RequestUser
  ): Promise<{ items: NotificationResponse[] }> {
    try {
      const limit = query.limit ?? 20;
      const filters = [];

      if (actor.roleCode === ROLE_CODES.employee) {
        if (query.userId && query.userId !== actor.userId) {
          throw new ForbiddenException("Employee cannot read another user's notifications");
        }

        filters.push(eq(schema.notifications.clientId, actor.clientId));
        filters.push(eq(schema.notifications.userId, actor.userId));
      } else if (actor.roleCode === ROLE_CODES.clientAdmin) {
        if (query.clientId && query.clientId !== actor.clientId) {
          throw new ForbiddenException("Client admin cannot read notifications from another client");
        }

        filters.push(eq(schema.notifications.clientId, actor.clientId));

        if (query.userId) {
          filters.push(eq(schema.notifications.userId, query.userId));
        }
      } else {
        if (query.clientId) {
          filters.push(eq(schema.notifications.clientId, query.clientId));
        }

        if (query.userId) {
          filters.push(eq(schema.notifications.userId, query.userId));
        }
      }

      const items = await this.databaseService.db
        .select()
        .from(schema.notifications)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(schema.notifications.createdAt))
        .limit(limit);

      return { items: items.map(toNotificationResponse) };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load notifications", {
        cause: error
      });
    }
  }

  async listLegacyNotificationsForActor(
    query: LegacyListNotificationsDto,
    actor: RequestUser
  ): Promise<{ items: LegacyNotificationItem[] }> {
    try {
      this.assertCanUseClient(query.clientId, actor);

      const filters = [eq(schema.notifications.clientId, query.clientId)];

      if (actor.roleCode === ROLE_CODES.employee) {
        filters.push(eq(schema.notifications.userId, actor.userId));
      }

      const notifications = await this.databaseService.db
        .select()
        .from(schema.notifications)
        .where(and(...filters))
        .orderBy(desc(schema.notifications.createdAt))
        .limit(query.limit ?? 500);

      const legacyItems = notifications.map((item) => ({
        id: item.legacyId ?? item.id,
        title: item.title,
        text: item.message,
        time: item.createdAt.toLocaleDateString("ru-RU", {
          day: "numeric",
          month: "long",
          hour: "2-digit",
          minute: "2-digit"
        }),
        target: item.userId
      }));

      if (actor.roleCode === ROLE_CODES.employee) {
        return { items: legacyItems };
      }

      const groupedByLegacyId = new Map<
        string,
        { item: LegacyNotificationItem; targetsCount: number }
      >();

      for (const item of legacyItems) {
        const existing = groupedByLegacyId.get(item.id);

        if (existing) {
          existing.targetsCount += 1;
          continue;
        }

        groupedByLegacyId.set(item.id, {
          item,
          targetsCount: 1
        });
      }

      return {
        items: Array.from(groupedByLegacyId.values()).map(({ item, targetsCount }) => ({
          ...item,
          target: targetsCount > 1 ? "Все" : item.target
        }))
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load legacy notifications", {
        cause: error
      });
    }
  }

  async createNotificationForActor(
    payload: CreateNotificationDto,
    actor: RequestUser
  ): Promise<{ item: NotificationResponse }> {
    try {
      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        payload.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot create notifications for another client");
      }

      if (actor.roleCode === ROLE_CODES.employee) {
        throw new ForbiddenException("Employee cannot create notifications");
      }

      const [user] = await this.databaseService.db
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.id, payload.userId),
            eq(schema.users.clientId, payload.clientId)
          )
        )
        .limit(1);

      if (!user) {
        throw new NotFoundException("User not found in the client");
      }

      if (payload.deadlineId) {
        const [deadline] = await this.databaseService.db
          .select()
          .from(schema.deadlines)
          .where(
            and(
              eq(schema.deadlines.id, payload.deadlineId),
              eq(schema.deadlines.clientId, payload.clientId)
            )
          )
          .limit(1);

        if (!deadline) {
          throw new NotFoundException("Deadline not found in the client");
        }
      }

      if (payload.documentId) {
        const [document] = await this.databaseService.db
          .select()
          .from(schema.documents)
          .where(
            and(
              eq(schema.documents.id, payload.documentId),
              eq(schema.documents.clientId, payload.clientId)
            )
          )
          .limit(1);

        if (!document) {
          throw new NotFoundException("Document not found in the client");
        }
      }

      const readAt = payload.status === "read" ? new Date() : null;

      const [item] = await this.databaseService.db
        .insert(schema.notifications)
        .values({
          clientId: payload.clientId,
          userId: payload.userId,
          deadlineId: payload.deadlineId,
          documentId: payload.documentId,
          title: payload.title,
          message: payload.message,
          channel: payload.channel ?? "in_app",
          status: payload.status ?? "unread",
          readAt,
          createdByUserId: actor.userId
        })
        .returning();

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: actor.userId,
        action: "notification.created",
        entityType: "notification",
        entityId: item.id,
        details: {
          userId: item.userId,
          deadlineId: item.deadlineId,
          documentId: item.documentId,
          channel: item.channel,
          status: item.status
        }
      });

      return { item: toNotificationResponse(item) };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to create notification", {
        cause: error
      });
    }
  }

  async syncLegacyNotificationsForActor(
    payload: LegacySyncNotificationsDto,
    actor: RequestUser
  ): Promise<{ total: number; created: number; updated: number; deleted: number; skipped: number }> {
    try {
      this.assertCanUseClient(payload.clientId, actor);

      if (!Array.isArray(payload.items)) {
        throw new BadRequestException("items must be an array");
      }

      const actorUserId = await this.getExistingActorUserId(actor.userId);
      const users = await this.databaseService.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.clientId, payload.clientId));
      const roleCodeById = await this.getRoleCodeById();
      const normalizedItems = payload.items
        .map((item) => this.normalizeLegacyNotification(item))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const incomingLegacyIds = Array.from(new Set(normalizedItems.map((item) => item.legacyId)));

      let deleted = 0;

      if (incomingLegacyIds.length > 0) {
        const deletedRows = await this.databaseService.db
          .delete(schema.notifications)
          .where(
            and(
              eq(schema.notifications.clientId, payload.clientId),
              isNotNull(schema.notifications.legacyId),
              notInArray(schema.notifications.legacyId, incomingLegacyIds)
            )
          )
          .returning({ id: schema.notifications.id });
        deleted = deletedRows.length;
      } else {
        const deletedRows = await this.databaseService.db
          .delete(schema.notifications)
          .where(
            and(
              eq(schema.notifications.clientId, payload.clientId),
              isNotNull(schema.notifications.legacyId)
            )
          )
          .returning({ id: schema.notifications.id });
        deleted = deletedRows.length;
      }

      const existingRows = await this.databaseService.db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.clientId, payload.clientId));
      const existingByLegacyUser = new Map(
        existingRows
          .filter((item) => item.legacyId)
          .map((item) => [`${item.legacyId}:${item.userId}`, item])
      );
      let created = 0;
      let updated = 0;
      let skipped = payload.items.length - normalizedItems.length;

      for (const item of normalizedItems) {
        const targetUsers = this.resolveLegacyTargetUsers(item.target, users, roleCodeById);

        if (targetUsers.length === 0) {
          skipped += 1;
          continue;
        }

        for (const user of targetUsers) {
          const existing = existingByLegacyUser.get(`${item.legacyId}:${user.id}`);

          if (existing) {
            await this.databaseService.db
              .update(schema.notifications)
              .set({
                title: item.title,
                message: item.text,
                status: item.status,
                readAt: item.status === "read" ? (existing.readAt ?? new Date()) : null,
                updatedAt: new Date()
              })
              .where(eq(schema.notifications.id, existing.id));
            updated += 1;
            continue;
          }

          await this.databaseService.db.insert(schema.notifications).values({
            clientId: payload.clientId,
            userId: user.id,
            legacyId: item.legacyId,
            title: item.title,
            message: item.text,
            channel: "in_app",
            status: item.status,
            readAt: item.status === "read" ? new Date() : null,
            createdByUserId: actorUserId
          });
          created += 1;
        }
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId,
        action: "notifications.legacy_synced",
        entityType: "notifications",
        entityId: payload.clientId,
        details: {
          total: payload.items.length,
          created,
          updated,
          deleted,
          skipped
        }
      });

      return {
        total: payload.items.length,
        created,
        updated,
        deleted,
        skipped
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync legacy notifications", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; scopedRoute: string } {
    return {
      module: "notifications",
      status: "active",
      scopedRoute: "/api/notifications/scoped"
    };
  }

  private assertCanUseClient(clientId: string, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.employee && clientId !== actor.clientId) {
      throw new ForbiddenException("Employee cannot use another client");
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && clientId !== actor.clientId) {
      throw new ForbiddenException("Client admin cannot use another client");
    }
  }

  private normalizeLegacyNotification(value: unknown): {
    legacyId: string;
    title: string;
    text: string;
    target: string;
    status: "unread" | "read";
  } | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const record = value as Record<string, unknown>;
    const legacyId = this.asNonEmptyString(record.id) ?? String(Date.now());
    const title = this.asNonEmptyString(record.title) ?? "Уведомление";
    const text = this.asNonEmptyString(record.text) ?? this.asNonEmptyString(record.message);
    const target = this.asNonEmptyString(record.target) ?? "Все";
    const status = record.status === "read" ? "read" : "unread";

    if (!text) {
      return null;
    }

    return {
      legacyId,
      title,
      text,
      target,
      status
    };
  }

  private resolveLegacyTargetUsers(
    target: string,
    users: Array<typeof schema.users.$inferSelect>,
    roleCodeById: Map<string, string>
  ): Array<typeof schema.users.$inferSelect> {
    const normalizedTarget = target.trim();

    if (!normalizedTarget || normalizedTarget === "Все" || normalizedTarget.toLowerCase() === "all") {
      return users;
    }

    if (normalizedTarget === "u_admin" || normalizedTarget.toLowerCase() === "admin") {
      return users.filter((user) => roleCodeById.get(user.roleId) !== ROLE_CODES.employee);
    }

    const exactUser = users.find((user) => {
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

      return (
        user.id === normalizedTarget ||
        user.email === normalizedTarget ||
        user.firstName === normalizedTarget ||
        fullName === normalizedTarget
      );
    });

    return exactUser ? [exactUser] : [];
  }

  private async getRoleCodeById(): Promise<Map<string, string>> {
    const roles = await this.databaseService.db.select().from(schema.roles);
    return new Map(roles.map((role) => [role.id, role.code]));
  }

  private asNonEmptyString(value: unknown): string | undefined {
    if (typeof value === "string" || typeof value === "number") {
      const trimmed = String(value).trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }

    return undefined;
  }

  private async getExistingActorUserId(value: string | null | undefined): Promise<string | undefined> {
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
