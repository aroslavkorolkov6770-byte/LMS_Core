import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import {
  LegacyGetDismissedTasksDto,
  LegacySyncDismissedTasksDto
} from "./dto/legacy-dismissed-tasks.dto";

@Injectable()
export class DismissedTasksService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async getLegacyForActor(
    query: LegacyGetDismissedTasksDto,
    actor: RequestUser
  ): Promise<{ clientId: string; userKey: string; taskKeys: string[]; exists: boolean }> {
    try {
      this.assertCanUseUserState(query.clientId, query.userKey, actor);

      const [state] = await this.databaseService.db
        .select({
          id: schema.userDismissedTasks.id,
          taskKeys: schema.userDismissedTasks.taskKeys
        })
        .from(schema.userDismissedTasks)
        .where(
          and(
            eq(schema.userDismissedTasks.clientId, query.clientId),
            eq(schema.userDismissedTasks.userKey, query.userKey)
          )
        )
        .limit(1);

      return {
        clientId: query.clientId,
        userKey: query.userKey,
        taskKeys: state?.taskKeys ?? [],
        exists: Boolean(state)
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load dismissed tasks", {
        cause: error
      });
    }
  }

  async syncLegacyForActor(
    payload: LegacySyncDismissedTasksDto,
    actor: RequestUser
  ): Promise<{ clientId: string; userKey: string; taskKeys: string[]; created: boolean }> {
    try {
      this.assertCanUseUserState(payload.clientId, payload.userKey, actor);
      const taskKeys = this.normalizeTaskKeys(payload.taskKeys);

      const [client] = await this.databaseService.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [existingState] = await this.databaseService.db
        .select({ id: schema.userDismissedTasks.id })
        .from(schema.userDismissedTasks)
        .where(
          and(
            eq(schema.userDismissedTasks.clientId, payload.clientId),
            eq(schema.userDismissedTasks.userKey, payload.userKey)
          )
        )
        .limit(1);
      const actorUserId = await this.getExistingActorUserId(actor.userId);
      let stateId: string;
      let created = false;

      if (existingState) {
        await this.databaseService.db
          .update(schema.userDismissedTasks)
          .set({
            taskKeys,
            updatedByUserId: actorUserId,
            updatedAt: new Date()
          })
          .where(eq(schema.userDismissedTasks.id, existingState.id));
        stateId = existingState.id;
      } else {
        const [createdState] = await this.databaseService.db
          .insert(schema.userDismissedTasks)
          .values({
            clientId: payload.clientId,
            userKey: payload.userKey,
            taskKeys,
            updatedByUserId: actorUserId
          })
          .returning({ id: schema.userDismissedTasks.id });
        stateId = createdState.id;
        created = true;
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId,
        action: "dismissed_tasks.synced",
        entityType: "user_dismissed_tasks",
        entityId: stateId,
        details: {
          total: taskKeys.length
        }
      });

      return {
        clientId: payload.clientId,
        userKey: payload.userKey,
        taskKeys,
        created
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync dismissed tasks", {
        cause: error
      });
    }
  }

  private assertCanUseUserState(clientId: string, userKey: string, actor: RequestUser): void {
    if (
      (actor.roleCode === ROLE_CODES.clientAdmin || actor.roleCode === ROLE_CODES.employee) &&
      actor.clientId !== clientId
    ) {
      throw new ForbiddenException("User cannot use dismissed tasks from another client");
    }

    if (actor.roleCode === ROLE_CODES.employee && actor.userId !== userKey) {
      throw new ForbiddenException("Employee cannot use another user's dismissed tasks");
    }
  }

  private normalizeTaskKeys(value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException("taskKeys must be an array");
    }

    const taskKeys = new Set<string>();

    for (const item of value) {
      if (typeof item !== "string" && typeof item !== "number") {
        throw new BadRequestException("Each dismissed task key must be a string or number");
      }

      const taskKey = String(item).trim();

      if (!taskKey) {
        continue;
      }

      if (taskKey.length > 300) {
        throw new BadRequestException("Dismissed task key is too long");
      }

      taskKeys.add(taskKey);
    }

    return Array.from(taskKeys);
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
