import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { CreateCourseDto } from "./dto/create-course.dto";
import { ListCoursesDto } from "./dto/list-courses.dto";
import { CourseResponse, toCourseResponse } from "./courses.presenter";

@Injectable()
export class CoursesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listCoursesForActor(
    query: ListCoursesDto,
    actor: RequestUser
  ): Promise<{ items: CourseResponse[] }> {
    try {
      const limit = query.limit ?? 20;
      const effectiveClientId =
        actor.roleCode === ROLE_CODES.clientAdmin ? actor.clientId : query.clientId;

      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        query.clientId &&
        query.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot read courses from another client");
      }

      if (effectiveClientId) {
        const items = await this.databaseService.db
          .select()
          .from(schema.courses)
          .where(eq(schema.courses.clientId, effectiveClientId))
          .orderBy(asc(schema.courses.orderIndex), desc(schema.courses.createdAt))
          .limit(limit);

        return { items: items.map(toCourseResponse) };
      }

      const items = await this.databaseService.db
        .select()
        .from(schema.courses)
        .orderBy(asc(schema.courses.orderIndex), desc(schema.courses.createdAt))
        .limit(limit);

      return { items: items.map(toCourseResponse) };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load courses", {
        cause: error
      });
    }
  }

  async createCourseForActor(
    payload: CreateCourseDto,
    actor: RequestUser
  ): Promise<{ item: CourseResponse }> {
    try {
      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        payload.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot create courses for another client");
      }

      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [existingCourse] = await this.databaseService.db
        .select()
        .from(schema.courses)
        .where(
          and(
            eq(schema.courses.clientId, payload.clientId),
            eq(schema.courses.slug, payload.slug)
          )
        )
        .limit(1);

      if (existingCourse) {
        throw new BadRequestException("Course with this slug already exists in the client");
      }

      const [item] = await this.databaseService.db
        .insert(schema.courses)
        .values({
          clientId: payload.clientId,
          title: payload.title,
          slug: payload.slug,
          description: payload.description,
          contentKind: payload.contentKind ?? "lesson",
          content: payload.content,
          roleLabel: payload.roleLabel,
          estimatedMinutes: payload.estimatedMinutes,
          orderIndex: payload.orderIndex ?? 0,
          isPublished: payload.isPublished ?? false,
          createdByUserId: actor.userId
        })
        .returning();

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: actor.userId,
        action: "course.created",
        entityType: "course",
        entityId: item.id,
        details: {
          title: item.title,
          slug: item.slug,
          contentKind: item.contentKind,
          isPublished: item.isPublished
        }
      });

      return { item: toCourseResponse(item) };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to create course", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; scopedRoute: string } {
    return {
      module: "courses",
      status: "active",
      scopedRoute: "/api/courses/scoped"
    };
  }
}
