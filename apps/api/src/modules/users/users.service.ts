import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { CORE_ROLES, ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { LegacyLoginDto } from "./dto/legacy-login.dto";
import { LegacyRegisterDto } from "./dto/legacy-register.dto";
import { LegacySyncUsersDto } from "./dto/legacy-sync-users.dto";
import { ListUsersDto } from "./dto/list-users.dto";
import { toUserResponse, UserResponse } from "./users.presenter";

type LegacyUserResponse = {
  id: string;
  login: string;
  role: "admin" | "staff";
  name: string;
  isRegistered: boolean;
  registered: boolean;
  backendUserId: string;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listUsers(query: ListUsersDto): Promise<{
    items: UserResponse[];
  }> {
    return this.listUsersForActor(query, {
      userId: "system-process",
      clientId: "",
      roleCode: ROLE_CODES.systemAdmin
    });
  }

  async listUsersForActor(
    query: ListUsersDto,
    actor: RequestUser
  ): Promise<{
    items: UserResponse[];
  }> {
    try {
      const limit = query.limit ?? 20;
      const effectiveClientId =
        actor.roleCode === ROLE_CODES.clientAdmin ? actor.clientId : query.clientId;

      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        query.clientId &&
        query.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot read users from another client");
      }

      if (effectiveClientId) {
        const items = await this.databaseService.db
          .select()
          .from(schema.users)
          .where(eq(schema.users.clientId, effectiveClientId))
          .orderBy(desc(schema.users.createdAt))
          .limit(limit);

        return { items: items.map(toUserResponse) };
      }

      const items = await this.databaseService.db
        .select()
        .from(schema.users)
        .orderBy(desc(schema.users.createdAt))
        .limit(limit);

      return { items: items.map(toUserResponse) };
    } catch (error) {
      throw new InternalServerErrorException("Failed to load users", {
        cause: error
      });
    }
  }

  async createUser(payload: CreateUserDto): Promise<{
    item: UserResponse;
  }> {
    return this.createUserForActor(payload, {
      userId: "system-process",
      clientId: payload.clientId,
      roleCode: ROLE_CODES.systemAdmin
    });
  }

  async listLegacyUsersForActor(
    query: ListUsersDto,
    actor: RequestUser
  ): Promise<{ items: LegacyUserResponse[] }> {
    try {
      const limit = query.limit ?? 200;
      const effectiveClientId =
        actor.roleCode === ROLE_CODES.clientAdmin ? actor.clientId : query.clientId;

      if (!effectiveClientId) {
        throw new ForbiddenException("clientId is required for legacy users");
      }

      this.assertCanUseClient(effectiveClientId, actor);

      const items = await this.databaseService.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.clientId, effectiveClientId))
        .orderBy(desc(schema.users.createdAt))
        .limit(limit);

      const rolesById = await this.getRolesById();

      return {
        items: items.map((user) =>
          this.toLegacyUserResponse(user, rolesById.get(user.roleId) ?? ROLE_CODES.employee)
        )
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load legacy users", {
        cause: error
      });
    }
  }

  async createUserForActor(
    payload: CreateUserDto,
    actor: RequestUser
  ): Promise<{
    item: UserResponse;
  }> {
    try {
      const allowedRoleCodes = CORE_ROLES.map((role) => role.code);

      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        payload.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot create users for another client");
      }

      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        payload.roleCode === ROLE_CODES.systemAdmin
      ) {
        throw new ForbiddenException("Client admin cannot create system admin users");
      }

      if (!allowedRoleCodes.includes(payload.roleCode)) {
        throw new BadRequestException("Unknown role code");
      }

      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [role] = await this.databaseService.db
        .select()
        .from(schema.roles)
        .where(eq(schema.roles.code, payload.roleCode))
        .limit(1);

      if (!role) {
        throw new NotFoundException("Role not found. Run role seed first.");
      }

      const [existingUser] = await this.databaseService.db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.clientId, payload.clientId), eq(schema.users.email, payload.email)))
        .limit(1);

      if (existingUser) {
        throw new BadRequestException("User with this email already exists in the client");
      }

      const [item] = await this.databaseService.db
        .insert(schema.users)
        .values({
          clientId: payload.clientId,
          roleId: role.id,
          email: payload.email,
          phone: payload.phone,
          firstName: payload.firstName,
          lastName: payload.lastName,
          passwordHash: this.hashPassword(payload.password)
        })
        .returning();

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "user.created",
        entityType: "user",
        entityId: item.id,
        details: {
          email: item.email,
          roleId: item.roleId
        }
      });

      return { item: toUserResponse(item) };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to create user", {
        cause: error
      });
    }
  }

  async legacyLoginForActor(
    payload: LegacyLoginDto,
    actor: RequestUser
  ): Promise<{ user: LegacyUserResponse }> {
    try {
      this.assertCanUseClient(payload.clientId, actor);

      const [user] = await this.databaseService.db
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.clientId, payload.clientId),
            eq(schema.users.email, payload.login)
          )
        )
        .limit(1);

      if (!user || !user.isActive || !this.verifyPassword(payload.password, user.passwordHash)) {
        throw new ForbiddenException("Invalid login or password");
      }

      const roleCode = await this.getRoleCode(user.roleId);

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "user.legacy_login",
        entityType: "user",
        entityId: user.id,
        details: {
          login: payload.login
        }
      });

      return {
        user: this.toLegacyUserResponse(user, roleCode)
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to login legacy user", {
        cause: error
      });
    }
  }

  async legacyRegisterForActor(
    payload: LegacyRegisterDto,
    actor: RequestUser
  ): Promise<{ user: LegacyUserResponse }> {
    try {
      const loginResult = await this.legacyLoginForActor(payload, actor);

      const [updatedUser] = await this.databaseService.db
        .update(schema.users)
        .set({
          firstName: payload.name,
          phone: payload.phone,
          updatedAt: new Date()
        })
        .where(eq(schema.users.id, loginResult.user.backendUserId))
        .returning();

      const roleCode = await this.getRoleCode(updatedUser.roleId);

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "user.legacy_registered",
        entityType: "user",
        entityId: updatedUser.id,
        details: {
          login: payload.login
        }
      });

      return {
        user: this.toLegacyUserResponse(updatedUser, roleCode)
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to register legacy user", {
        cause: error
      });
    }
  }

  async legacySyncUsersForActor(
    payload: LegacySyncUsersDto,
    actor: RequestUser
  ): Promise<{ total: number; created: number; updated: number; skipped: number }> {
    try {
      this.assertCanUseClient(payload.clientId, actor);

      if (!Array.isArray(payload.users)) {
        throw new BadRequestException("users must be an array");
      }

      const rolesByCode = await this.getRolesByCode();
      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const legacyUser of payload.users) {
        const login = this.asNonEmptyString(legacyUser?.login);
        const password = this.asNonEmptyString(legacyUser?.pass);
        const roleCode = legacyUser?.role === "admin" ? ROLE_CODES.clientAdmin : ROLE_CODES.employee;
        const role = rolesByCode.get(roleCode);

        if (!login || !role) {
          skipped += 1;
          continue;
        }

        const name = this.asNonEmptyString(legacyUser?.name) ?? login;

        const [existingUser] = await this.databaseService.db
          .select()
          .from(schema.users)
          .where(
            and(
              eq(schema.users.clientId, payload.clientId),
              eq(schema.users.email, login)
            )
          )
          .limit(1);

        if (existingUser) {
          await this.databaseService.db
            .update(schema.users)
            .set({
              roleId: role.id,
              firstName: name,
              passwordHash: password ? this.hashPassword(password) : existingUser.passwordHash,
              updatedAt: new Date()
            })
            .where(eq(schema.users.id, existingUser.id));
          updated += 1;
          continue;
        }

        if (!password) {
          skipped += 1;
          continue;
        }

        await this.databaseService.db.insert(schema.users).values({
          clientId: payload.clientId,
          roleId: role.id,
          email: login,
          phone: null,
          firstName: name,
          lastName: null,
          passwordHash: this.hashPassword(password),
          isActive: true
        });
        created += 1;
      }

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "users.legacy_synced",
        entityType: "users",
        entityId: payload.clientId,
        details: {
          total: payload.users.length,
          created,
          updated,
          skipped
        }
      });

      return {
        total: payload.users.length,
        created,
        updated,
        skipped
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync legacy users", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; roles: string[] } {
    return {
      module: "users",
      status: "active",
      roles: CORE_ROLES.map((role) => role.code)
    };
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const derivedKey = scryptSync(password, salt, 64).toString("hex");

    return `${salt}:${derivedKey}`;
  }

  private verifyPassword(password: string, passwordHash: string): boolean {
    const [salt, storedHash] = passwordHash.split(":");

    if (!salt || !storedHash) {
      return false;
    }

    const derivedHash = scryptSync(password, salt, 64).toString("hex");
    const storedBuffer = Buffer.from(storedHash, "hex");
    const derivedBuffer = Buffer.from(derivedHash, "hex");

    if (storedBuffer.length !== derivedBuffer.length) {
      return false;
    }

    return timingSafeEqual(storedBuffer, derivedBuffer);
  }

  private assertCanUseClient(clientId: string, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.clientAdmin && clientId !== actor.clientId) {
      throw new ForbiddenException("Client admin cannot use another client");
    }
  }

  private async getRoleCode(roleId: string): Promise<string> {
    const [role] = await this.databaseService.db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.id, roleId))
      .limit(1);

    return role?.code ?? ROLE_CODES.employee;
  }

  private async getRolesByCode(): Promise<Map<string, typeof schema.roles.$inferSelect>> {
    const roles = await this.databaseService.db.select().from(schema.roles);
    return new Map(roles.map((role) => [role.code, role]));
  }

  private async getRolesById(): Promise<Map<string, string>> {
    const roles = await this.databaseService.db.select().from(schema.roles);
    return new Map(roles.map((role) => [role.id, role.code]));
  }

  private toLegacyUserResponse(
    user: typeof schema.users.$inferSelect,
    roleCode: string
  ): LegacyUserResponse {
    const legacyRole = roleCode === ROLE_CODES.employee ? "staff" : "admin";
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

    return {
      id: user.id,
      login: user.email,
      role: legacyRole,
      name: name || user.email,
      isRegistered: true,
      registered: true,
      backendUserId: user.id
    };
  }

  private asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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
