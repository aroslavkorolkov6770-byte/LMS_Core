import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, desc, eq, notInArray } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import {
  LegacyListPushSubscriptionsDto,
  LegacyPushSubscriptionItem,
  LegacySyncPushSubscriptionsDto
} from "./dto/legacy-push-subscriptions.dto";

type NormalizedPushSubscription = {
  userKey: string;
  endpoint: string;
  subscription: unknown;
};

@Injectable()
export class PushSubscriptionsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listLegacyForActor(
    query: LegacyListPushSubscriptionsDto,
    actor: RequestUser
  ): Promise<{ items: LegacyPushSubscriptionItem[] }> {
    try {
      this.assertCanUseClient(query.clientId, actor);

      const items = await this.databaseService.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.clientId, query.clientId))
        .orderBy(desc(schema.pushSubscriptions.updatedAt))
        .limit(query.limit ?? 500);

      return {
        items: items.map((item) => ({
          userId: item.userKey,
          sub: item.subscription
        }))
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load legacy push subscriptions", {
        cause: error
      });
    }
  }

  async syncLegacyForActor(
    payload: LegacySyncPushSubscriptionsDto,
    actor: RequestUser
  ): Promise<{ total: number; created: number; updated: number; deleted: number; skipped: number }> {
    try {
      this.assertCanUseClient(payload.clientId, actor);

      if (!Array.isArray(payload.items)) {
        throw new BadRequestException("items must be an array");
      }

      const [client] = await this.databaseService.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const normalizedByEndpoint = new Map<string, NormalizedPushSubscription>();

      for (const item of payload.items) {
        const normalized = this.normalizeLegacyItem(item);

        if (normalized) {
          normalizedByEndpoint.set(normalized.endpoint, normalized);
        }
      }

      const normalizedItems = Array.from(normalizedByEndpoint.values());
      const incomingEndpoints = normalizedItems.map((item) => item.endpoint);
      const existingRows = await this.databaseService.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.clientId, payload.clientId));
      const existingByEndpoint = new Map(existingRows.map((item) => [item.endpoint, item]));

      let deleted = 0;

      if (incomingEndpoints.length > 0) {
        const deletedRows = await this.databaseService.db
          .delete(schema.pushSubscriptions)
          .where(
            and(
              eq(schema.pushSubscriptions.clientId, payload.clientId),
              notInArray(schema.pushSubscriptions.endpoint, incomingEndpoints)
            )
          )
          .returning({ id: schema.pushSubscriptions.id });
        deleted = deletedRows.length;
      } else {
        const deletedRows = await this.databaseService.db
          .delete(schema.pushSubscriptions)
          .where(eq(schema.pushSubscriptions.clientId, payload.clientId))
          .returning({ id: schema.pushSubscriptions.id });
        deleted = deletedRows.length;
      }

      let created = 0;
      let updated = 0;

      for (const item of normalizedItems) {
        const existing = existingByEndpoint.get(item.endpoint);

        if (existing) {
          await this.databaseService.db
            .update(schema.pushSubscriptions)
            .set({
              userKey: item.userKey,
              subscription: item.subscription,
              updatedAt: new Date()
            })
            .where(eq(schema.pushSubscriptions.id, existing.id));
          updated += 1;
          continue;
        }

        await this.databaseService.db.insert(schema.pushSubscriptions).values({
          clientId: payload.clientId,
          userKey: item.userKey,
          endpoint: item.endpoint,
          subscription: item.subscription
        });
        created += 1;
      }

      const actorUserId = await this.getExistingActorUserId(actor.userId);

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId,
        action: "push_subscriptions.legacy_synced",
        entityType: "push_subscriptions",
        entityId: payload.clientId,
        details: {
          total: payload.items.length,
          created,
          updated,
          deleted,
          skipped: payload.items.length - normalizedItems.length
        }
      });

      return {
        total: payload.items.length,
        created,
        updated,
        deleted,
        skipped: payload.items.length - normalizedItems.length
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync legacy push subscriptions", {
        cause: error
      });
    }
  }

  private assertCanUseClient(clientId: string, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.employee && clientId !== actor.clientId) {
      throw new ForbiddenException("Employee cannot use another client");
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && clientId !== actor.clientId) {
      throw new ForbiddenException("Client admin cannot use another client");
    }
  }

  private normalizeLegacyItem(value: unknown): NormalizedPushSubscription | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const record = value as Record<string, unknown>;
    const subscription = record.sub ?? record.subscription;

    if (!subscription || typeof subscription !== "object") {
      return null;
    }

    const subscriptionRecord = subscription as Record<string, unknown>;
    const endpoint = this.asNonEmptyString(subscriptionRecord.endpoint);

    if (!endpoint) {
      return null;
    }

    return {
      userKey: this.asNonEmptyString(record.userId) ?? "guest",
      endpoint,
      subscription
    };
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
