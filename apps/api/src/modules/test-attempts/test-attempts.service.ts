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
import { LegacyListPassedTestsDto } from "./dto/legacy-list-passed-tests.dto";
import { LegacyListTestAttemptsDto } from "./dto/legacy-list-test-attempts.dto";
import { LegacySyncPassedTestsDto } from "./dto/legacy-sync-passed-tests.dto";
import { LegacySyncTestResultsDto } from "./dto/legacy-sync-test-results.dto";

type LegacyTestResult = {
  id: string;
  testId: string;
  userId: string;
  userName: string;
  testName: string;
  score: number;
  attempts: number;
  date: string;
};

@Injectable()
export class TestAttemptsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listLegacyResultsForActor(
    query: LegacyListTestAttemptsDto,
    actor: RequestUser
  ): Promise<{ items: LegacyTestResult[] }> {
    try {
      this.assertCanRead(query.clientId, query.userId, actor);

      const filters = [eq(schema.testAttempts.clientId, query.clientId)];

      if (query.userId) {
        filters.push(eq(schema.testAttempts.userId, query.userId));
      }

      const attempts = await this.databaseService.db
        .select()
        .from(schema.testAttempts)
        .where(and(...filters))
        .orderBy(desc(schema.testAttempts.createdAt));

      const users = await this.databaseService.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.clientId, query.clientId));
      const usersById = new Map(users.map((user) => [user.id, user]));

      return {
        items: attempts.map((attempt) => {
          const user = usersById.get(attempt.userId);
          const userName = user
            ? [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
            : "Сотрудник";

          return {
            id: attempt.legacyAttemptId ?? attempt.id,
            testId: attempt.legacyTestSlug,
            userId: attempt.userId,
            userName,
            testName: attempt.testTitle,
            score: attempt.score,
            attempts: attempt.attemptNumber,
            date: attempt.createdAt.toLocaleDateString("ru-RU", {
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit"
            })
          };
        })
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load test attempts", {
        cause: error
      });
    }
  }

  async listLegacyPassedForActor(
    query: LegacyListPassedTestsDto,
    actor: RequestUser
  ): Promise<{ passedTestSlugs: string[] }> {
    try {
      this.assertCanRead(query.clientId, query.userId, actor);

      const attempts = await this.databaseService.db
        .select()
        .from(schema.testAttempts)
        .where(
          and(
            eq(schema.testAttempts.clientId, query.clientId),
            eq(schema.testAttempts.userId, query.userId),
            eq(schema.testAttempts.isPassed, true)
          )
        );

      return {
        passedTestSlugs: Array.from(new Set(attempts.map((attempt) => attempt.legacyTestSlug)))
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load passed tests", {
        cause: error
      });
    }
  }

  async syncLegacyResultsForActor(
    payload: LegacySyncTestResultsDto,
    actor: RequestUser
  ): Promise<{ total: number; created: number; updated: number; skipped: number }> {
    try {
      this.assertCanWrite(payload.clientId, undefined, actor);

      if (!Array.isArray(payload.results)) {
        throw new BadRequestException("results must be an array");
      }

      const context = await this.loadClientContext(payload.clientId);
      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const item of payload.results) {
        const normalized = this.normalizeLegacyResult(item, context.usersByName);

        if (!normalized) {
          skipped += 1;
          continue;
        }

        const test = context.testsBySlug.get(normalized.legacyTestSlug);
        const existing = normalized.legacyAttemptId
          ? await this.findByLegacyAttemptId(payload.clientId, normalized.legacyAttemptId)
          : null;

        if (existing) {
          await this.databaseService.db
            .update(schema.testAttempts)
            .set({
              userId: normalized.userId,
              testId: test?.id,
              legacyTestSlug: normalized.legacyTestSlug,
              testTitle: normalized.testTitle,
              score: normalized.score,
              isPassed: normalized.score >= 80,
              attemptNumber: normalized.attemptNumber,
              mistakes: normalized.mistakes
            })
            .where(eq(schema.testAttempts.id, existing.id));
          updated += 1;
          continue;
        }

        await this.databaseService.db.insert(schema.testAttempts).values({
          clientId: payload.clientId,
          userId: normalized.userId,
          testId: test?.id,
          legacyAttemptId: normalized.legacyAttemptId,
          legacyTestSlug: normalized.legacyTestSlug,
          testTitle: normalized.testTitle,
          score: normalized.score,
          isPassed: normalized.score >= 80,
          attemptNumber: normalized.attemptNumber,
          mistakes: normalized.mistakes,
          source: "lms_legacy_results"
        });
        created += 1;
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "test_attempts.legacy_results_synced",
        entityType: "test_attempts",
        entityId: payload.clientId,
        details: {
          total: payload.results.length,
          created,
          updated,
          skipped
        }
      });

      return {
        total: payload.results.length,
        created,
        updated,
        skipped
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync test attempts", {
        cause: error
      });
    }
  }

  async syncLegacyPassedForActor(
    payload: LegacySyncPassedTestsDto,
    actor: RequestUser
  ): Promise<{ passedTestSlugs: string[]; created: number; existing: number }> {
    try {
      this.assertCanWrite(payload.clientId, payload.userId, actor);

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

      const tests = await this.databaseService.db
        .select()
        .from(schema.tests)
        .where(eq(schema.tests.clientId, payload.clientId));
      const testsBySlug = new Map(tests.map((test) => [test.slug, test]));
      const passedTestSlugs = Array.from(new Set(payload.passedTestSlugs)).filter(Boolean);
      let created = 0;
      let existing = 0;

      for (const slug of passedTestSlugs) {
        const alreadyPassed = await this.findPassedAttempt(payload.clientId, payload.userId, slug);

        if (alreadyPassed) {
          existing += 1;
          continue;
        }

        const test = testsBySlug.get(slug);
        const attemptNumber = await this.getNextAttemptNumber(payload.clientId, payload.userId, slug);

        await this.databaseService.db.insert(schema.testAttempts).values({
          clientId: payload.clientId,
          userId: payload.userId,
          testId: test?.id,
          legacyAttemptId: `passed:${payload.userId}:${slug}`,
          legacyTestSlug: slug,
          testTitle: test?.title ?? slug,
          score: 100,
          isPassed: true,
          attemptNumber,
          source: "lms_legacy_passed"
        });
        created += 1;
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "test_attempts.legacy_passed_synced",
        entityType: "test_attempts",
        entityId: payload.userId,
        details: {
          passedTestSlugs,
          created,
          existing
        }
      });

      return {
        passedTestSlugs,
        created,
        existing
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync passed tests", {
        cause: error
      });
    }
  }

  private async loadClientContext(clientId: string): Promise<{
    usersByName: Map<string, string>;
    testsBySlug: Map<string, typeof schema.tests.$inferSelect>;
  }> {
    const [users, tests] = await Promise.all([
      this.databaseService.db.select().from(schema.users).where(eq(schema.users.clientId, clientId)),
      this.databaseService.db.select().from(schema.tests).where(eq(schema.tests.clientId, clientId))
    ]);

    return {
      usersByName: new Map(
        users.map((user) => [
          [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email,
          user.id
        ])
      ),
      testsBySlug: new Map(tests.map((test) => [test.slug, test]))
    };
  }

  private normalizeLegacyResult(
    value: any,
    usersByName: Map<string, string>
  ): {
    legacyAttemptId: string | undefined;
    legacyTestSlug: string;
    userId: string;
    testTitle: string;
    score: number;
    attemptNumber: number;
    mistakes: unknown;
  } | null {
    const legacyTestSlug = this.asNonEmptyString(value?.testId);
    const explicitUserId = this.asUuid(value?.userId) ?? this.asUuid(value?.backendUserId);
    const userName = this.asNonEmptyString(value?.userName);
    const userId = explicitUserId ?? (userName ? usersByName.get(userName) : undefined);
    const score = this.toScore(value?.score);

    if (!legacyTestSlug || !userId || score === null) {
      return null;
    }

    const testTitle = this.asNonEmptyString(value?.testName) ?? legacyTestSlug;

    return {
      legacyAttemptId: value?.id === undefined || value?.id === null ? undefined : String(value.id),
      legacyTestSlug,
      userId,
      testTitle,
      score,
      attemptNumber: this.toPositiveInt(value?.attempts) ?? 1,
      mistakes: Array.isArray(value?.mistakes) ? value.mistakes : undefined
    };
  }

  private async findByLegacyAttemptId(
    clientId: string,
    legacyAttemptId: string
  ): Promise<typeof schema.testAttempts.$inferSelect | null> {
    const [attempt] = await this.databaseService.db
      .select()
      .from(schema.testAttempts)
      .where(
        and(
          eq(schema.testAttempts.clientId, clientId),
          eq(schema.testAttempts.legacyAttemptId, legacyAttemptId)
        )
      )
      .limit(1);

    return attempt ?? null;
  }

  private async findPassedAttempt(
    clientId: string,
    userId: string,
    legacyTestSlug: string
  ): Promise<typeof schema.testAttempts.$inferSelect | null> {
    const [attempt] = await this.databaseService.db
      .select()
      .from(schema.testAttempts)
      .where(
        and(
          eq(schema.testAttempts.clientId, clientId),
          eq(schema.testAttempts.userId, userId),
          eq(schema.testAttempts.legacyTestSlug, legacyTestSlug),
          eq(schema.testAttempts.isPassed, true)
        )
      )
      .limit(1);

    return attempt ?? null;
  }

  private async getNextAttemptNumber(
    clientId: string,
    userId: string,
    legacyTestSlug: string
  ): Promise<number> {
    const attempts = await this.databaseService.db
      .select()
      .from(schema.testAttempts)
      .where(
        and(
          eq(schema.testAttempts.clientId, clientId),
          eq(schema.testAttempts.userId, userId),
          eq(schema.testAttempts.legacyTestSlug, legacyTestSlug)
        )
      );

    return attempts.length + 1;
  }

  private assertCanRead(clientId: string, userId: string | undefined, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.employee) {
      if (actor.clientId !== clientId || (userId && actor.userId !== userId)) {
        throw new ForbiddenException("Employee cannot read another user's test attempts");
      }
      return;
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && actor.clientId !== clientId) {
      throw new ForbiddenException("Client admin cannot read another client's test attempts");
    }
  }

  private assertCanWrite(clientId: string, userId: string | undefined, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.employee) {
      if (actor.clientId !== clientId || (userId && actor.userId !== userId)) {
        throw new ForbiddenException("Employee cannot write another user's test attempts");
      }
      return;
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && actor.clientId !== clientId) {
      throw new ForbiddenException("Client admin cannot write another client's test attempts");
    }
  }

  private asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private asUuid(value: unknown): string | undefined {
    const text = this.asNonEmptyString(value);

    if (!text) {
      return undefined;
    }

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    return uuidPattern.test(text) ? text : undefined;
  }

  private toScore(value: unknown): number | null {
    const numberValue = Number(value);

    if (!Number.isFinite(numberValue)) {
      return null;
    }

    return Math.max(0, Math.min(100, Math.round(numberValue)));
  }

  private toPositiveInt(value: unknown): number | undefined {
    const numberValue = Number(value);

    if (!Number.isInteger(numberValue) || numberValue < 1) {
      return undefined;
    }

    return numberValue;
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
}
