import {
  BadRequestException,
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
import { CreateTestDto } from "./dto/create-test.dto";
import { ListTestsDto } from "./dto/list-tests.dto";
import { TestResponse, toTestResponse } from "./tests.presenter";

@Injectable()
export class TestsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listTestsForActor(
    query: ListTestsDto,
    actor: RequestUser
  ): Promise<{ items: TestResponse[] }> {
    try {
      const limit = query.limit ?? 20;
      const effectiveClientId =
        actor.roleCode === ROLE_CODES.clientAdmin ? actor.clientId : query.clientId;

      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        query.clientId &&
        query.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot read tests from another client");
      }

      const filters = [];

      if (effectiveClientId) {
        filters.push(eq(schema.tests.clientId, effectiveClientId));
      }

      if (query.courseId) {
        filters.push(eq(schema.tests.courseId, query.courseId));
      }

      const items = await this.databaseService.db
        .select()
        .from(schema.tests)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(schema.tests.orderIndex, desc(schema.tests.createdAt))
        .limit(limit);

      return { items: items.map(toTestResponse) };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load tests", {
        cause: error
      });
    }
  }

  async createTestForActor(
    payload: CreateTestDto,
    actor: RequestUser
  ): Promise<{ item: TestResponse }> {
    try {
      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        payload.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot create tests for another client");
      }

      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
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

      const [existingTest] = await this.databaseService.db
        .select()
        .from(schema.tests)
        .where(
          and(
            eq(schema.tests.clientId, payload.clientId),
            eq(schema.tests.slug, payload.slug)
          )
        )
        .limit(1);

      if (existingTest) {
        throw new BadRequestException("Test with this slug already exists in the client");
      }

      const [item] = await this.databaseService.db
        .insert(schema.tests)
        .values({
          clientId: payload.clientId,
          courseId: payload.courseId,
          title: payload.title,
          slug: payload.slug,
          description: payload.description,
          contentKind: payload.contentKind ?? "quiz",
          content: payload.content,
          passingScore: payload.passingScore ?? 80,
          timeLimitMinutes: payload.timeLimitMinutes,
          orderIndex: payload.orderIndex ?? 0,
          isPublished: payload.isPublished ?? false,
          createdByUserId: actor.userId
        })
        .returning();

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: actor.userId,
        action: "test.created",
        entityType: "test",
        entityId: item.id,
        details: {
          title: item.title,
          slug: item.slug,
          courseId: item.courseId,
          contentKind: item.contentKind,
          isPublished: item.isPublished
        }
      });

      return { item: toTestResponse(item) };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to create test", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; scopedRoute: string } {
    return {
      module: "tests",
      status: "active",
      scopedRoute: "/api/tests/scoped"
    };
  }
}
