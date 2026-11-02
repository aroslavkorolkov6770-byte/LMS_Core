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
import { CreateDeadlineDto } from "./dto/create-deadline.dto";
import { ListDeadlinesDto } from "./dto/list-deadlines.dto";
import { DeadlineResponse, toDeadlineResponse } from "./deadlines.presenter";

@Injectable()
export class DeadlinesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listDeadlinesForActor(
    query: ListDeadlinesDto,
    actor: RequestUser
  ): Promise<{ items: DeadlineResponse[] }> {
    try {
      const limit = query.limit ?? 20;
      const filters = [];

      if (actor.roleCode === ROLE_CODES.employee) {
        if (query.userId && query.userId !== actor.userId) {
          throw new ForbiddenException("Employee cannot read another user's deadlines");
        }

        filters.push(eq(schema.deadlines.clientId, actor.clientId));
        filters.push(eq(schema.deadlines.userId, actor.userId));
      } else if (actor.roleCode === ROLE_CODES.clientAdmin) {
        if (query.clientId && query.clientId !== actor.clientId) {
          throw new ForbiddenException("Client admin cannot read deadlines from another client");
        }

        filters.push(eq(schema.deadlines.clientId, actor.clientId));

        if (query.userId) {
          filters.push(eq(schema.deadlines.userId, query.userId));
        }
      } else {
        if (query.clientId) {
          filters.push(eq(schema.deadlines.clientId, query.clientId));
        }

        if (query.userId) {
          filters.push(eq(schema.deadlines.userId, query.userId));
        }
      }

      if (query.courseId) {
        filters.push(eq(schema.deadlines.courseId, query.courseId));
      }

      const items = await this.databaseService.db
        .select()
        .from(schema.deadlines)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(schema.deadlines.dueAt), desc(schema.deadlines.createdAt))
        .limit(limit);

      return { items: items.map(toDeadlineResponse) };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load deadlines", {
        cause: error
      });
    }
  }

  async createDeadlineForActor(
    payload: CreateDeadlineDto,
    actor: RequestUser
  ): Promise<{ item: DeadlineResponse }> {
    try {
      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        payload.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot create deadlines for another client");
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

      if (payload.courseId) {
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
      }

      if (payload.testId) {
        const [test] = await this.databaseService.db
          .select()
          .from(schema.tests)
          .where(
            and(
              eq(schema.tests.id, payload.testId),
              eq(schema.tests.clientId, payload.clientId)
            )
          )
          .limit(1);

        if (!test) {
          throw new NotFoundException("Test not found in the client");
        }
      }

      const completedAt = payload.status === "completed" ? new Date() : null;

      const [item] = await this.databaseService.db
        .insert(schema.deadlines)
        .values({
          clientId: payload.clientId,
          userId: payload.userId,
          courseId: payload.courseId,
          testId: payload.testId,
          title: payload.title,
          status: payload.status ?? "active",
          dueAt: new Date(payload.dueAt),
          completedAt,
          createdByUserId: actor.userId
        })
        .returning();

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: actor.userId,
        action: "deadline.created",
        entityType: "deadline",
        entityId: item.id,
        details: {
          userId: item.userId,
          courseId: item.courseId,
          testId: item.testId,
          status: item.status,
          dueAt: item.dueAt
        }
      });

      return { item: toDeadlineResponse(item) };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to create deadline", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; scopedRoute: string } {
    return {
      module: "deadlines",
      status: "active",
      scopedRoute: "/api/deadlines/scoped"
    };
  }
}
