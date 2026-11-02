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
  LegacyGetUserProfileDataDto,
  LegacySaveUserProfileDataDto
} from "./dto/legacy-user-profile-data.dto";

@Injectable()
export class UserProfileDataService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async getLegacyForActor(
    query: LegacyGetUserProfileDataDto,
    actor: RequestUser
  ): Promise<{ clientId: string; userKey: string; payload: unknown | null }> {
    try {
      this.assertCanUseProfile(query.clientId, query.userKey, actor);

      const [profile] = await this.databaseService.db
        .select({ payload: schema.userProfileData.payload })
        .from(schema.userProfileData)
        .where(
          and(
            eq(schema.userProfileData.clientId, query.clientId),
            eq(schema.userProfileData.userKey, query.userKey)
          )
        )
        .limit(1);

      return {
        clientId: query.clientId,
        userKey: query.userKey,
        payload: profile?.payload ?? null
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load user profile data", {
        cause: error
      });
    }
  }

  async saveLegacyForActor(
    payload: LegacySaveUserProfileDataDto,
    actor: RequestUser
  ): Promise<{ clientId: string; userKey: string; saved: true }> {
    try {
      this.assertCanUseProfile(payload.clientId, payload.userKey, actor);
      const normalizedPayload = this.normalizeProfilePayload(payload.payload);

      const [client] = await this.databaseService.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const actorUserId = await this.getExistingActorUserId(actor.userId);
      const savedProfileId = await this.databaseService.db.transaction(async (tx) => {
        await tx
          .delete(schema.userProfileData)
          .where(
            and(
              eq(schema.userProfileData.clientId, payload.clientId),
              eq(schema.userProfileData.userKey, payload.userKey)
            )
          );

        const [savedProfile] = await tx
          .insert(schema.userProfileData)
          .values({
            clientId: payload.clientId,
            userKey: payload.userKey,
            payload: normalizedPayload,
            updatedByUserId: actorUserId
          })
          .returning({ id: schema.userProfileData.id });

        return savedProfile.id;
      });

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId,
        action: "user_profile_data.saved",
        entityType: "user_profile_data",
        entityId: savedProfileId,
        details: {
          scope: "user-profile"
        }
      });

      return {
        clientId: payload.clientId,
        userKey: payload.userKey,
        saved: true
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to save user profile data", {
        cause: error
      });
    }
  }

  private assertCanUseProfile(clientId: string, userKey: string, actor: RequestUser): void {
    if (
      (actor.roleCode === ROLE_CODES.clientAdmin || actor.roleCode === ROLE_CODES.employee) &&
      clientId !== actor.clientId
    ) {
      throw new ForbiddenException("User cannot use a profile from another client");
    }

    if (actor.roleCode === ROLE_CODES.employee && userKey !== actor.userId) {
      throw new ForbiddenException("Employee cannot use another user's profile");
    }
  }

  private normalizeProfilePayload(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("payload must be an object");
    }

    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch (error) {
      throw new BadRequestException("payload must contain valid JSON data", {
        cause: error
      });
    }
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
