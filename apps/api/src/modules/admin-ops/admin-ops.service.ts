import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { randomBytes, scryptSync } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { GetClientContentDto } from "./dto/get-client-content.dto";
import { ImportClientSeedDto } from "./dto/import-client-seed.dto";
import { ListAdminAuditDto } from "./dto/list-admin-audit.dto";
import { UpsertClientContentDto } from "./dto/upsert-client-content.dto";

type AdminAuditItem = typeof schema.auditLog.$inferSelect;
type CourseInsert = typeof schema.courses.$inferInsert;
type TestInsert = typeof schema.tests.$inferInsert;

type AdminAuditResponse = {
  items: AdminAuditItem[];
};

type ImportClientSeedResponse = {
  clientId: string;
  resetExisting: boolean;
  courses: {
    total: number;
    created: number;
    updated: number;
  };
  tests: {
    total: number;
    created: number;
    updated: number;
  };
  content: {
    importedKeys: string[];
  };
  users: {
    total: number;
    created: number;
    existing: number;
  };
};

@Injectable()
export class AdminOpsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listRecentAuditForActor(
    query: ListAdminAuditDto,
    actor: RequestUser
  ): Promise<AdminAuditResponse> {
    try {
      const limit = query.limit ?? 10;

      if (actor.roleCode === ROLE_CODES.clientAdmin) {
        if (query.clientId && query.clientId !== actor.clientId) {
          throw new ForbiddenException("Client admin cannot read audit events from another client");
        }

        const items = await this.databaseService.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.clientId, actor.clientId))
          .orderBy(desc(schema.auditLog.createdAt))
          .limit(limit);

        return { items };
      }

      const items = query.clientId
        ? await this.databaseService.db
            .select()
            .from(schema.auditLog)
            .where(and(eq(schema.auditLog.clientId, query.clientId)))
            .orderBy(desc(schema.auditLog.createdAt))
            .limit(limit)
        : await this.databaseService.db
            .select()
            .from(schema.auditLog)
            .orderBy(desc(schema.auditLog.createdAt))
            .limit(limit);

      return { items };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load recent audit events", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; auditRoute: string } {
    return {
      module: "admin-ops",
      status: "active",
      auditRoute: "/api/admin-ops/audit-recent"
    };
  }

  async importClientSeedForActor(
    payload: ImportClientSeedDto,
    actor: RequestUser
  ): Promise<ImportClientSeedResponse> {
    try {
      if (actor.roleCode === ROLE_CODES.clientAdmin && payload.clientId !== actor.clientId) {
        throw new ForbiddenException("Client admin cannot import seed for another client");
      }

      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const seedDirectory = await this.resolveSeedDirectory();
      const [routeSeed, testsSeed, assortmentSeed, productsSeed, usersSeed] = await Promise.all([
        this.readSeedJson(path.join(seedDirectory, "tea_hub_dynamic_route_v2.json")),
        this.readOptionalSeedJson(path.join(seedDirectory, "tea_hub_dynamic_tests_v1.json")),
        this.readSeedJson(path.join(seedDirectory, "tea_hub_assortment_matrix_v1.json")),
        this.readSeedJson(path.join(seedDirectory, "tea_hub_products_v1.json")),
        this.readSeedJson(path.join(seedDirectory, "tea_hub_users_v1.json"))
      ]);

      const courseRows = this.mapRouteSeedToCourses(payload.clientId, routeSeed);
      const testRows = this.mapDynamicTestsSeedToTests(payload.clientId, testsSeed);
      const userRows = this.mapUsersSeedToUsers(usersSeed);
      const contentRows = [
        {
          key: "tea_hub_assortment_matrix_v2",
          payload: this.normalizeJsonForDatabase(assortmentSeed)
        },
        {
          key: "tea_hub_products_v1",
          payload: this.normalizeJsonForDatabase(productsSeed)
        }
      ];
      const resetExisting = payload.resetExisting ?? false;
      const contentActorUserId = await this.getExistingActorUserId(actor.userId);
      const rolesByCode = await this.getRolesByCode();

      const result = await this.databaseService.db.transaction(async (tx) => {
        if (resetExisting) {
          await tx.delete(schema.tests).where(eq(schema.tests.clientId, payload.clientId));
          await tx.delete(schema.courses).where(eq(schema.courses.clientId, payload.clientId));
          await tx
            .delete(schema.clientContent)
            .where(eq(schema.clientContent.clientId, payload.clientId));
        }

        const existingCourses = await tx
          .select()
          .from(schema.courses)
          .where(eq(schema.courses.clientId, payload.clientId));
        const existingTests = await tx
          .select()
          .from(schema.tests)
          .where(eq(schema.tests.clientId, payload.clientId));

        const courseMap = new Map(existingCourses.map((item) => [item.slug, item]));
        const testMap = new Map(existingTests.map((item) => [item.slug, item]));

        let createdCourses = 0;
        let updatedCourses = 0;
        let createdTests = 0;
        let updatedTests = 0;
        let createdUsers = 0;
        let existingUsers = 0;

        for (const row of courseRows) {
          const existing = courseMap.get(row.slug);

          if (existing) {
            await tx
              .update(schema.courses)
              .set({
                title: row.title,
                description: row.description,
                contentKind: row.contentKind,
                content: row.content,
                roleLabel: row.roleLabel,
                estimatedMinutes: row.estimatedMinutes,
                orderIndex: row.orderIndex,
                isPublished: row.isPublished,
                updatedAt: new Date()
              })
              .where(eq(schema.courses.id, existing.id));
            updatedCourses += 1;
            continue;
          }

          await tx.insert(schema.courses).values(row);
          createdCourses += 1;
        }

        for (const row of testRows) {
          const existing = testMap.get(row.slug);

          if (existing) {
            await tx
              .update(schema.tests)
              .set({
                title: row.title,
                description: row.description,
                contentKind: row.contentKind,
                content: row.content,
                passingScore: row.passingScore,
                timeLimitMinutes: row.timeLimitMinutes,
                orderIndex: row.orderIndex,
                isPublished: row.isPublished,
                updatedAt: new Date()
              })
              .where(eq(schema.tests.id, existing.id));
            updatedTests += 1;
            continue;
          }

          await tx.insert(schema.tests).values(row);
          createdTests += 1;
        }

        for (const row of contentRows) {
          await tx
            .delete(schema.clientContent)
            .where(
              and(
                eq(schema.clientContent.clientId, payload.clientId),
                eq(schema.clientContent.key, row.key)
              )
            );

          await tx.insert(schema.clientContent).values({
            clientId: payload.clientId,
            key: row.key,
            payload: row.payload,
            updatedByUserId: contentActorUserId
          });
        }

        for (const row of userRows) {
          const roleCode = row.role === "admin" ? ROLE_CODES.clientAdmin : ROLE_CODES.employee;
          const role = rolesByCode.get(roleCode);

          if (!role) {
            throw new NotFoundException(`Role not found: ${roleCode}`);
          }

          const [existingUser] = await tx
            .select()
            .from(schema.users)
            .where(
              and(
                eq(schema.users.clientId, payload.clientId),
                eq(schema.users.email, row.login)
              )
            )
            .limit(1);

          if (existingUser) {
            existingUsers += 1;
            continue;
          }

          await tx.insert(schema.users).values({
            clientId: payload.clientId,
            roleId: role.id,
            email: row.login,
            phone: null,
            firstName: row.name,
            lastName: null,
            passwordHash: this.hashPassword(row.password),
            isActive: true
          });
          createdUsers += 1;
        }

        return {
          courses: {
            total: courseRows.length,
            created: createdCourses,
            updated: updatedCourses
          },
          tests: {
            total: testRows.length,
            created: createdTests,
            updated: updatedTests
          },
          content: {
            importedKeys: contentRows.map((item) => item.key)
          },
          users: {
            total: userRows.length,
            created: createdUsers,
            existing: existingUsers
          }
        };
      });

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: contentActorUserId,
        action: "client.seed_imported",
        entityType: "client",
        entityId: payload.clientId,
        details: {
          resetExisting,
          courses: result.courses,
          tests: result.tests,
          content: result.content,
          users: result.users
        }
      });

      return {
        clientId: payload.clientId,
        resetExisting,
        courses: result.courses,
        tests: result.tests,
        content: result.content,
        users: result.users
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to import client seed", {
        cause: error
      });
    }
  }

  private async resolveSeedDirectory(): Promise<string> {
    const candidates = [
      path.resolve(process.cwd(), "..", "lms-web", "data", "seed"),
      path.resolve(process.cwd(), "apps", "lms-web", "data", "seed"),
      path.resolve(process.cwd(), "data", "seed")
    ];

    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }

    throw new NotFoundException("Seed directory not found");
  }

  private async readSeedJson(filePath: string): Promise<unknown> {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  }

  private async readOptionalSeedJson(filePath: string): Promise<unknown> {
    try {
      return await this.readSeedJson(filePath);
    } catch {
      return [];
    }
  }

  private mapRouteSeedToCourses(clientId: string, seed: unknown): CourseInsert[] {
    if (!Array.isArray(seed)) {
      throw new BadRequestException("Route seed has invalid format");
    }

    return seed.map((item, index) => {
      const routeItem = item as Record<string, unknown>;
      const title = this.asRequiredText(routeItem.title, `Маршрут ${index + 1}`);

      return {
        clientId,
        title,
        slug: this.asRequiredText(routeItem.id, `route_${index + 1}`),
        description: this.asText(routeItem.h1, null),
        contentKind: "route_lesson",
        content: routeItem,
        roleLabel: null,
        estimatedMinutes: this.parseMinutes(routeItem.time),
        orderIndex: index,
        isPublished: true
      };
    });
  }

  private mapDynamicTestsSeedToTests(clientId: string, seed: unknown): TestInsert[] {
    if (!Array.isArray(seed)) {
      throw new BadRequestException("Tests seed has invalid format");
    }

    return seed.map((item, index) => {
      const testItem = item as Record<string, unknown>;
      const title = this.asRequiredText(testItem.title ?? testItem.name, `Тест ${index + 1}`);
      const slug = this.asRequiredText(testItem.id, `test_${index + 1}`);
      const timeLimit = Number(testItem.timeLimit);

      return {
      clientId,
        title,
        slug,
        description: this.asText(testItem.subtitle, null),
        contentKind: "legacy_quiz",
        content: testItem,
      passingScore: 80,
        timeLimitMinutes: Number.isInteger(timeLimit) && timeLimit > 0 ? timeLimit : null,
      orderIndex: index,
        isPublished: testItem.isPlaceholder !== true
      };
    });
  }

  private mapUsersSeedToUsers(seed: unknown): Array<{
    login: string;
    password: string;
    role: "admin" | "staff";
    name: string;
  }> {
    if (!Array.isArray(seed)) {
      throw new BadRequestException("Users seed has invalid format");
    }

    return seed
      .map((item: any) => ({
        login: this.asText(item?.login, "") ?? "",
        password: this.asText(item?.pass, "") ?? "",
        role: item?.role === "admin" ? "admin" as const : "staff" as const,
        name: this.asText(item?.name, item?.role === "admin" ? "Главный Мастер" : "Сотрудник") ?? "Сотрудник"
      }))
      .filter((item) => item.login && item.password);
  }

  private parseMinutes(value: unknown): number | null {
    if (typeof value !== "string") {
      return null;
    }

    const match = value.match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  private asText(value: unknown, fallback: string | null): string | null {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    return fallback;
  }

  private asRequiredText(value: unknown, fallback: string): string {
    return this.asText(value, fallback) ?? fallback;
  }

  private normalizeJsonForDatabase(value: unknown): unknown {
    if (typeof value === "string") {
      return value
        .replace(/≥/g, ">=")
        .replace(/≤/g, "<=")
        .replace(/→/g, "->")
        .replace(/←/g, "<-")
        .replace(/—/g, "-")
        .replace(/–/g, "-")
        .replace(/…/g, "...")
        .replace(/[\uD800-\uDFFF]/g, "");
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeJsonForDatabase(item));
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          this.normalizeJsonForDatabase(item)
        ])
      );
    }

    return value;
  }

  private async getRolesByCode(): Promise<Map<string, typeof schema.roles.$inferSelect>> {
    const roles = await this.databaseService.db.select().from(schema.roles);
    return new Map(roles.map((role) => [role.code, role]));
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const derivedKey = scryptSync(password, salt, 64).toString("hex");

    return `${salt}:${derivedKey}`;
  }

  async getClientContentForActor(
    query: GetClientContentDto,
    actor: RequestUser
  ): Promise<{ clientId: string; key: string; payload: unknown | null }> {
    try {
      if (actor.roleCode === ROLE_CODES.clientAdmin && query.clientId !== actor.clientId) {
        throw new ForbiddenException("Client admin cannot read content from another client");
      }

      const [item] = await this.databaseService.db
        .select()
        .from(schema.clientContent)
        .where(
          and(
            eq(schema.clientContent.clientId, query.clientId),
            eq(schema.clientContent.key, query.key)
          )
        )
        .limit(1);

      return {
        clientId: query.clientId,
        key: query.key,
        payload: item?.payload ?? null
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load client content", {
        cause: error
      });
    }
  }

  async upsertClientContentForActor(
    payload: UpsertClientContentDto,
    actor: RequestUser
  ): Promise<{ clientId: string; key: string; saved: true }> {
    try {
      if (actor.roleCode === ROLE_CODES.clientAdmin && payload.clientId !== actor.clientId) {
        throw new ForbiddenException("Client admin cannot update content for another client");
      }

      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const contentActorUserId = await this.getExistingActorUserId(actor.userId);

      await this.databaseService.db.transaction(async (tx) => {
        await tx
          .delete(schema.clientContent)
          .where(
            and(
              eq(schema.clientContent.clientId, payload.clientId),
              eq(schema.clientContent.key, payload.key)
            )
          );

        await tx.insert(schema.clientContent).values({
          clientId: payload.clientId,
          key: payload.key,
          payload: this.normalizeJsonForDatabase(payload.payload),
          updatedByUserId: contentActorUserId
        });
      });

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: contentActorUserId,
        action: "client_content.upserted",
        entityType: "client_content",
        entityId: payload.key,
        details: {
          key: payload.key
        }
      });

      return {
        clientId: payload.clientId,
        key: payload.key,
        saved: true
      };
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to save client content", {
        cause: error
      });
    }
  }

  private toOptionalUuid(value: string | null | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    return uuidPattern.test(value) ? value : undefined;
  }

  private async getExistingActorUserId(value: string | null | undefined): Promise<string | undefined> {
    const candidate = this.toOptionalUuid(value);

    if (!candidate) {
      return undefined;
    }

    const [user] = await this.databaseService.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, candidate))
      .limit(1);

    return user?.id;
  }
}
