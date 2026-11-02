import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { ListLearningContentDto } from "./dto/list-learning-content.dto";
import { SyncLegacyRouteDto } from "./dto/sync-legacy-route.dto";
import { SyncLegacyTestsDto } from "./dto/sync-legacy-tests.dto";
import {
  LegacyLearningRouteItem,
  LegacyLearningTestItem,
  courseToLegacyRouteItem,
  isArchivedLegacyContent,
  testToLegacyTestItem
} from "./learning-content.presenter";

type SyncResult = {
  total: number;
  created: number;
  updated: number;
  archived: number;
  skipped: number;
};

type NormalizedRouteItem = {
  slug: string;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  orderIndex: number;
  content: LegacyLearningRouteItem & Record<string, unknown>;
  isPublished: boolean;
};

type NormalizedTestItem = {
  slug: string;
  title: string;
  description: string | null;
  passingScore: number;
  timeLimitMinutes: number | null;
  orderIndex: number;
  content: LegacyLearningTestItem & Record<string, unknown>;
  isPublished: boolean;
};

@Injectable()
export class LearningContentService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listLegacyRouteForActor(
    query: ListLearningContentDto,
    actor: RequestUser
  ): Promise<{ items: LegacyLearningRouteItem[] }> {
    try {
      this.assertCanReadClient(query.clientId, actor);

      const courses = await this.databaseService.db
        .select()
        .from(schema.courses)
        .where(eq(schema.courses.clientId, query.clientId))
        .orderBy(asc(schema.courses.orderIndex), asc(schema.courses.createdAt));

      return {
        items: courses
          .filter((course) => !isArchivedLegacyContent(course.content))
          .map(courseToLegacyRouteItem)
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load legacy route content", {
        cause: error
      });
    }
  }

  async listLegacyTestsForActor(
    query: ListLearningContentDto,
    actor: RequestUser
  ): Promise<{ items: LegacyLearningTestItem[] }> {
    try {
      this.assertCanReadClient(query.clientId, actor);

      const tests = await this.databaseService.db
        .select()
        .from(schema.tests)
        .where(eq(schema.tests.clientId, query.clientId))
        .orderBy(asc(schema.tests.orderIndex), asc(schema.tests.createdAt));

      return {
        items: tests
          .filter((test) => !isArchivedLegacyContent(test.content))
          .map(testToLegacyTestItem)
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load legacy test content", {
        cause: error
      });
    }
  }

  async listLearningContentForActor(
    query: ListLearningContentDto,
    actor: RequestUser
  ): Promise<{
    clientId: string;
    route: LegacyLearningRouteItem[];
    tests: LegacyLearningTestItem[];
  }> {
    const [route, tests] = await Promise.all([
      this.listLegacyRouteForActor(query, actor),
      this.listLegacyTestsForActor(query, actor)
    ]);

    return {
      clientId: query.clientId,
      route: route.items,
      tests: tests.items
    };
  }

  async syncLegacyRouteForActor(
    payload: SyncLegacyRouteDto,
    actor: RequestUser
  ): Promise<{ result: SyncResult }> {
    try {
      this.assertCanWriteClient(payload.clientId, actor);
      await this.assertClientExists(payload.clientId);

      const normalized = this.normalizeRouteItems(payload.items);
      const existingCourses = await this.databaseService.db
        .select()
        .from(schema.courses)
        .where(eq(schema.courses.clientId, payload.clientId));
      const existingBySlug = new Map(existingCourses.map((course) => [course.slug, course]));
      const incomingSlugs = new Set(normalized.map((item) => item.slug));
      let created = 0;
      let updated = 0;
      let archived = 0;

      for (const item of normalized) {
        const existing = existingBySlug.get(item.slug);

        if (existing) {
          await this.databaseService.db
            .update(schema.courses)
            .set({
              title: item.title,
              description: item.description,
              contentKind: "legacy_route",
              content: item.content,
              estimatedMinutes: item.estimatedMinutes,
              orderIndex: item.orderIndex,
              isPublished: item.isPublished,
              updatedAt: new Date()
            })
            .where(eq(schema.courses.id, existing.id));
          updated += 1;
          continue;
        }

        await this.databaseService.db.insert(schema.courses).values({
          clientId: payload.clientId,
          title: item.title,
          slug: item.slug,
          description: item.description,
          contentKind: "legacy_route",
          content: item.content,
          estimatedMinutes: item.estimatedMinutes,
          orderIndex: item.orderIndex,
          isPublished: item.isPublished,
          createdByUserId: await this.getExistingActorUserId(actor.userId)
        });
        created += 1;
      }

      for (const course of existingCourses) {
        if (incomingSlugs.has(course.slug) || isArchivedLegacyContent(course.content)) {
          continue;
        }

        await this.databaseService.db
          .update(schema.courses)
          .set({
            isPublished: false,
            content: {
              ...this.asRecord(course.content),
              isArchivedByLegacySync: true
            },
            updatedAt: new Date()
          })
          .where(eq(schema.courses.id, course.id));
        archived += 1;
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "learning_content.legacy_route_synced",
        entityType: "learning_content",
        entityId: payload.clientId,
        details: {
          total: payload.items.length,
          created,
          updated,
          archived,
          skipped: payload.items.length - normalized.length
        }
      });

      return {
        result: {
          total: payload.items.length,
          created,
          updated,
          archived,
          skipped: payload.items.length - normalized.length
        }
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync legacy route content", {
        cause: error
      });
    }
  }

  async syncLegacyTestsForActor(
    payload: SyncLegacyTestsDto,
    actor: RequestUser
  ): Promise<{ result: SyncResult }> {
    try {
      this.assertCanWriteClient(payload.clientId, actor);
      await this.assertClientExists(payload.clientId);

      const normalized = this.normalizeTestItems(payload.items);
      const existingTests = await this.databaseService.db
        .select()
        .from(schema.tests)
        .where(eq(schema.tests.clientId, payload.clientId));
      const existingBySlug = new Map(existingTests.map((test) => [test.slug, test]));
      const incomingSlugs = new Set(normalized.map((item) => item.slug));
      let created = 0;
      let updated = 0;
      let archived = 0;

      for (const item of normalized) {
        const existing = existingBySlug.get(item.slug);

        if (existing) {
          await this.databaseService.db
            .update(schema.tests)
            .set({
              title: item.title,
              description: item.description,
              contentKind: "legacy_quiz",
              content: item.content,
              passingScore: item.passingScore,
              timeLimitMinutes: item.timeLimitMinutes,
              orderIndex: item.orderIndex,
              isPublished: item.isPublished,
              updatedAt: new Date()
            })
            .where(eq(schema.tests.id, existing.id));
          updated += 1;
          continue;
        }

        await this.databaseService.db.insert(schema.tests).values({
          clientId: payload.clientId,
          title: item.title,
          slug: item.slug,
          description: item.description,
          contentKind: "legacy_quiz",
          content: item.content,
          passingScore: item.passingScore,
          timeLimitMinutes: item.timeLimitMinutes,
          orderIndex: item.orderIndex,
          isPublished: item.isPublished,
          createdByUserId: await this.getExistingActorUserId(actor.userId)
        });
        created += 1;
      }

      for (const test of existingTests) {
        if (incomingSlugs.has(test.slug) || isArchivedLegacyContent(test.content)) {
          continue;
        }

        await this.databaseService.db
          .update(schema.tests)
          .set({
            isPublished: false,
            content: {
              ...this.asRecord(test.content),
              isArchivedByLegacySync: true
            },
            updatedAt: new Date()
          })
          .where(eq(schema.tests.id, test.id));
        archived += 1;
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "learning_content.legacy_tests_synced",
        entityType: "learning_content",
        entityId: payload.clientId,
        details: {
          total: payload.items.length,
          created,
          updated,
          archived,
          skipped: payload.items.length - normalized.length
        }
      });

      return {
        result: {
          total: payload.items.length,
          created,
          updated,
          archived,
          skipped: payload.items.length - normalized.length
        }
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync legacy test content", {
        cause: error
      });
    }
  }

  private normalizeRouteItems(items: unknown[]): NormalizedRouteItem[] {
    const usedSlugs = new Set<string>();

    return items
      .map((value, index) => this.normalizeRouteItem(value, index, usedSlugs))
      .filter((item): item is NormalizedRouteItem => Boolean(item));
  }

  private normalizeRouteItem(
    value: unknown,
    index: number,
    usedSlugs: Set<string>
  ): NormalizedRouteItem | null {
    const item = this.asRecord(value);
    const isPlaceholder = item.isPlaceholder === true;
    const rawTitle = this.asString(item.title) ?? this.asString(item.h1);
    const title = rawTitle ?? (isPlaceholder ? "Пустой раздел" : "");

    if (!title) {
      return null;
    }

    const slug = this.toUniqueSlug(this.asString(item.id) ?? this.asString(item.slug) ?? title, "route", index, usedSlugs);
    const section = this.asString(item.section) ?? "Основной раздел";
    const content: LegacyLearningRouteItem & Record<string, unknown> = {
      ...item,
      id: slug,
      title,
      time: this.asString(item.time) ?? "5 мин",
      section,
      h1: this.asString(item.h1) ?? title,
      t1: this.asString(item.t1) ?? "",
      isPlaceholder,
      isArchivedByLegacySync: false
    };

    return {
      slug,
      title,
      description: this.asString(item.t1) ?? this.asString(item.videoDesc) ?? null,
      estimatedMinutes: this.parseMinutes(item.time),
      orderIndex: index,
      content,
      isPublished: !isPlaceholder
    };
  }

  private normalizeTestItems(items: unknown[]): NormalizedTestItem[] {
    const usedSlugs = new Set<string>();

    return items
      .map((value, index) => this.normalizeTestItem(value, index, usedSlugs))
      .filter((item): item is NormalizedTestItem => Boolean(item));
  }

  private normalizeTestItem(
    value: unknown,
    index: number,
    usedSlugs: Set<string>
  ): NormalizedTestItem | null {
    const item = this.asRecord(value);
    const isPlaceholder = item.isPlaceholder === true;
    const title = this.asString(item.title) ?? (isPlaceholder ? "Пустой раздел тестов" : "");

    if (!title) {
      return null;
    }

    const slug = this.toUniqueSlug(this.asString(item.id) ?? this.asString(item.slug) ?? title, "test", index, usedSlugs);
    const section = this.asString(item.section) ?? "Основной раздел";
    const quiz = Array.isArray(item.quiz)
      ? item.quiz.map((question) => this.normalizeQuizQuestion(question)).filter((question): question is LegacyLearningTestItem["quiz"][number] => Boolean(question))
      : [];
    const content: LegacyLearningTestItem & Record<string, unknown> = {
      ...item,
      id: slug,
      title,
      subtitle: this.asString(item.subtitle) ?? "",
      theory: this.asString(item.theory) ?? "",
      section,
      timeLimit: this.toPositiveInteger(item.timeLimit) ?? 0,
      quiz,
      isPlaceholder,
      isArchivedByLegacySync: false
    };

    return {
      slug,
      title,
      description: this.asString(item.subtitle) ?? this.asString(item.theory) ?? null,
      passingScore: this.toScore(item.passingScore) ?? 80,
      timeLimitMinutes: this.toPositiveInteger(item.timeLimit) ?? null,
      orderIndex: index,
      content,
      isPublished: !isPlaceholder
    };
  }

  private normalizeQuizQuestion(value: unknown): LegacyLearningTestItem["quiz"][number] | null {
    const item = this.asRecord(value);
    const options = Array.isArray(item.o)
      ? item.o.map((option) => String(option ?? "").trim()).filter(Boolean)
      : [];

    if (options.length === 0) {
      return null;
    }

    return {
      q: this.asString(item.q) ?? "Контрольный вопрос",
      o: options,
      c: this.toPositiveInteger(item.c) ?? 0
    };
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

  private assertCanReadClient(clientId: string, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.clientAdmin && actor.clientId !== clientId) {
      throw new ForbiddenException("Client admin cannot read another client's learning content");
    }
  }

  private assertCanWriteClient(clientId: string, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.clientAdmin && actor.clientId !== clientId) {
      throw new ForbiddenException("Client admin cannot write another client's learning content");
    }
  }

  private toUniqueSlug(
    value: string,
    prefix: string,
    index: number,
    usedSlugs: Set<string>
  ): string {
    const base = this.toSlug(value) || `${prefix}-${index + 1}`;
    let candidate = base;
    let counter = 2;

    while (usedSlugs.has(candidate)) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }

    usedSlugs.add(candidate);
    return candidate;
  }

  private toSlug(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
  }

  private parseMinutes(value: unknown): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return value;
    }

    if (typeof value !== "string") {
      return null;
    }

    const match = value.match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private toPositiveInteger(value: unknown): number | undefined {
    const numberValue = Number(value);

    if (!Number.isInteger(numberValue) || numberValue < 0) {
      return undefined;
    }

    return numberValue;
  }

  private toScore(value: unknown): number | undefined {
    const numberValue = Number(value);

    if (!Number.isInteger(numberValue)) {
      return undefined;
    }

    return Math.max(0, Math.min(100, numberValue));
  }

  private async getExistingActorUserId(value: string | null | undefined): Promise<string | undefined> {
    const userId = this.asUuid(value);

    if (!userId) {
      return undefined;
    }

    const [user] = await this.databaseService.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    return user?.id;
  }

  private asUuid(value: unknown): string | undefined {
    const text = this.asString(value);

    if (!text) {
      return undefined;
    }

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

    return uuidPattern.test(text) ? text : undefined;
  }
}
