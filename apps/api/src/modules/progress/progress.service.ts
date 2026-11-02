import {
  ForbiddenException,
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
import { LegacyListProgressDto } from "./dto/legacy-list-progress.dto";
import { LegacySyncProgressDto } from "./dto/legacy-sync-progress.dto";
import { ListProgressDto } from "./dto/list-progress.dto";
import { SaveProgressDto } from "./dto/save-progress.dto";
import { ProgressResponse, toProgressResponse } from "./progress.presenter";

@Injectable()
export class ProgressService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listProgressForActor(
    query: ListProgressDto,
    actor: RequestUser
  ): Promise<{ items: ProgressResponse[] }> {
    try {
      const limit = query.limit ?? 20;
      const filters = [];

      if (actor.roleCode === ROLE_CODES.employee) {
        if (query.userId && query.userId !== actor.userId) {
          throw new ForbiddenException("Employee cannot read another user's progress");
        }

        if (query.clientId && query.clientId !== actor.clientId) {
          throw new ForbiddenException("Employee cannot read progress from another client");
        }

        filters.push(eq(schema.progress.userId, actor.userId));
        filters.push(eq(schema.progress.clientId, actor.clientId));
      } else if (actor.roleCode === ROLE_CODES.clientAdmin) {
        if (query.clientId && query.clientId !== actor.clientId) {
          throw new ForbiddenException("Client admin cannot read progress from another client");
        }

        filters.push(eq(schema.progress.clientId, actor.clientId));

        if (query.userId) {
          filters.push(eq(schema.progress.userId, query.userId));
        }
      } else {
        if (query.clientId) {
          filters.push(eq(schema.progress.clientId, query.clientId));
        }

        if (query.userId) {
          filters.push(eq(schema.progress.userId, query.userId));
        }
      }

      if (query.courseId) {
        filters.push(eq(schema.progress.courseId, query.courseId));
      }

      const items = await this.databaseService.db
        .select()
        .from(schema.progress)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(schema.progress.updatedAt))
        .limit(limit);

      return { items: items.map(toProgressResponse) };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load progress", {
        cause: error
      });
    }
  }

  async saveProgressForActor(
    payload: SaveProgressDto,
    actor: RequestUser
  ): Promise<{ item: ProgressResponse }> {
    try {
      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        payload.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot save progress for another client");
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

      const [course] = await this.databaseService.db
        .select()
        .from(schema.courses)
        .where(
          and(
            eq(schema.courses.id, payload.courseId),
            eq(schema.courses.clientId, payload.clientId)
          )
        )
        .limit(1);

      if (!course) {
        throw new NotFoundException("Course not found in the client");
      }

      if (payload.lastTestId) {
        const [test] = await this.databaseService.db
          .select()
          .from(schema.tests)
          .where(
            and(
              eq(schema.tests.id, payload.lastTestId),
              eq(schema.tests.clientId, payload.clientId)
            )
          )
          .limit(1);

        if (!test) {
          throw new NotFoundException("Test not found in the client");
        }
      }

      const completedAt = payload.status === "completed" ? new Date() : null;

      const [existingProgress] = await this.databaseService.db
        .select()
        .from(schema.progress)
        .where(
          and(
            eq(schema.progress.userId, payload.userId),
            eq(schema.progress.courseId, payload.courseId)
          )
        )
        .limit(1);

      if (existingProgress) {
        const [updatedItem] = await this.databaseService.db
          .update(schema.progress)
          .set({
            lastTestId: payload.lastTestId,
            status: payload.status,
            completionPercent: payload.completionPercent,
            completedAt,
            updatedAt: new Date()
          })
          .where(eq(schema.progress.id, existingProgress.id))
          .returning();

        await this.auditService.writeLog({
          clientId: payload.clientId,
          actorUserId: actor.userId,
          action: "progress.updated",
          entityType: "progress",
          entityId: updatedItem.id,
          details: {
            userId: updatedItem.userId,
            courseId: updatedItem.courseId,
            status: updatedItem.status,
            completionPercent: updatedItem.completionPercent
          }
        });

        return { item: toProgressResponse(updatedItem) };
      }

      const [createdItem] = await this.databaseService.db
        .insert(schema.progress)
        .values({
          clientId: payload.clientId,
          userId: payload.userId,
          courseId: payload.courseId,
          lastTestId: payload.lastTestId,
          status: payload.status,
          completionPercent: payload.completionPercent,
          completedAt
        })
        .returning();

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: actor.userId,
        action: "progress.created",
        entityType: "progress",
        entityId: createdItem.id,
        details: {
          userId: createdItem.userId,
          courseId: createdItem.courseId,
          status: createdItem.status,
          completionPercent: createdItem.completionPercent
        }
      });

      return { item: toProgressResponse(createdItem) };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to save progress", {
        cause: error
      });
    }
  }

  async listLegacyRouteProgressForActor(
    query: LegacyListProgressDto,
    actor: RequestUser
  ): Promise<{ completedRouteSlugs: string[] }> {
    try {
      this.assertCanReadUserProgress(query.clientId, query.userId, actor);

      const rows = await this.databaseService.db
        .select({
          slug: schema.courses.slug
        })
        .from(schema.progress)
        .innerJoin(schema.courses, eq(schema.progress.courseId, schema.courses.id))
        .where(
          and(
            eq(schema.progress.clientId, query.clientId),
            eq(schema.progress.userId, query.userId),
            eq(schema.progress.status, "completed")
          )
        );

      return {
        completedRouteSlugs: rows.map((row) => row.slug)
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load legacy route progress", {
        cause: error
      });
    }
  }

  async syncLegacyRouteProgressForActor(
    payload: LegacySyncProgressDto,
    actor: RequestUser
  ): Promise<{ completedRouteSlugs: string[]; created: number; updated: number }> {
    try {
      this.assertCanWriteUserProgress(payload.clientId, payload.userId, actor);

      const completedRouteSlugs = Array.from(new Set(payload.completedRouteSlugs)).filter(Boolean);

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

      const courses = await this.databaseService.db
        .select()
        .from(schema.courses)
        .where(eq(schema.courses.clientId, payload.clientId));

      const coursesBySlug = new Map(courses.map((course) => [course.slug, course]));
      let created = 0;
      let updated = 0;

      for (const slug of completedRouteSlugs) {
        const course = coursesBySlug.get(slug);

        if (!course) {
          continue;
        }

        const [existingProgress] = await this.databaseService.db
          .select()
          .from(schema.progress)
          .where(
            and(
              eq(schema.progress.userId, payload.userId),
              eq(schema.progress.courseId, course.id)
            )
          )
          .limit(1);

        if (existingProgress) {
          await this.databaseService.db
            .update(schema.progress)
            .set({
              status: "completed",
              completionPercent: 100,
              completedAt: existingProgress.completedAt ?? new Date(),
              updatedAt: new Date()
            })
            .where(eq(schema.progress.id, existingProgress.id));
          updated += 1;
          continue;
        }

        await this.databaseService.db.insert(schema.progress).values({
          clientId: payload.clientId,
          userId: payload.userId,
          courseId: course.id,
          status: "completed",
          completionPercent: 100,
          completedAt: new Date()
        });
        created += 1;
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "progress.legacy_route_synced",
        entityType: "progress",
        entityId: payload.userId,
        details: {
          userId: payload.userId,
          completedRouteSlugs,
          created,
          updated
        }
      });

      return {
        completedRouteSlugs,
        created,
        updated
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync legacy route progress", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; scopedRoute: string } {
    return {
      module: "progress",
      status: "active",
      scopedRoute: "/api/progress/scoped"
    };
  }

  private assertCanReadUserProgress(
    clientId: string,
    userId: string,
    actor: RequestUser
  ): void {
    if (actor.roleCode === ROLE_CODES.employee) {
      if (actor.clientId !== clientId || actor.userId !== userId) {
        throw new ForbiddenException("Employee cannot read another user's progress");
      }
      return;
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && actor.clientId !== clientId) {
      throw new ForbiddenException("Client admin cannot read another client's progress");
    }
  }

  private assertCanWriteUserProgress(
    clientId: string,
    userId: string,
    actor: RequestUser
  ): void {
    if (actor.roleCode === ROLE_CODES.employee) {
      if (actor.clientId !== clientId || actor.userId !== userId) {
        throw new ForbiddenException("Employee cannot write another user's progress");
      }
      return;
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && actor.clientId !== clientId) {
      throw new ForbiddenException("Client admin cannot write another client's progress");
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
