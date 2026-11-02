import {
  BadRequestException,
  ForbiddenException,
  HttpException,
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
  LegacyGetAiHistoryDto,
  LegacySaveAiHistoryDto
} from "./dto/legacy-ai-history.dto";
import { AiHistoryCryptoService } from "./ai-history-crypto.service";

type AiHistoryMessage = {
  id: string;
  role: "user" | "ai";
  content: string;
  timestamp: string;
};

type AiHistorySession = {
  id: string;
  title: string;
  messages: AiHistoryMessage[];
  updatedAt: number;
  isPinned?: boolean;
};

@Injectable()
export class AiHistoryService {
  private readonly maxSessions = 100;
  private readonly maxMessagesPerSession = 500;
  private readonly maxSerializedBytes = 5 * 1024 * 1024;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService,
    private readonly cryptoService: AiHistoryCryptoService
  ) {}

  async getLegacyForActor(
    query: LegacyGetAiHistoryDto,
    actor: RequestUser
  ): Promise<{
    clientId: string;
    userKey: string;
    sessions: AiHistorySession[];
    exists: boolean;
  }> {
    try {
      this.assertCanUseHistory(query.clientId, query.userKey, actor);

      const [record] = await this.databaseService.db
        .select({
          ciphertext: schema.aiHistoryRecords.ciphertext,
          iv: schema.aiHistoryRecords.iv,
          authTag: schema.aiHistoryRecords.authTag,
          encryptionVersion: schema.aiHistoryRecords.encryptionVersion
        })
        .from(schema.aiHistoryRecords)
        .where(
          and(
            eq(schema.aiHistoryRecords.clientId, query.clientId),
            eq(schema.aiHistoryRecords.userKey, query.userKey)
          )
        )
        .limit(1);

      if (!record) {
        return {
          clientId: query.clientId,
          userKey: query.userKey,
          sessions: [],
          exists: false
        };
      }

      const sessions = this.cryptoService.decrypt<AiHistorySession[]>(
        record,
        query.clientId,
        query.userKey
      );

      return {
        clientId: query.clientId,
        userKey: query.userKey,
        sessions: this.normalizeSessions(sessions),
        exists: true
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load AI history", {
        cause: error
      });
    }
  }

  async saveLegacyForActor(
    payload: LegacySaveAiHistoryDto,
    actor: RequestUser
  ): Promise<{
    clientId: string;
    userKey: string;
    sessionCount: number;
    messageCount: number;
    created: boolean;
  }> {
    try {
      this.assertCanUseHistory(payload.clientId, payload.userKey, actor);
      const sessions = this.normalizeSessions(payload.sessions);
      const encrypted = this.cryptoService.encrypt(
        sessions,
        payload.clientId,
        payload.userKey
      );

      const [client] = await this.databaseService.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [existingRecord] = await this.databaseService.db
        .select({ id: schema.aiHistoryRecords.id })
        .from(schema.aiHistoryRecords)
        .where(
          and(
            eq(schema.aiHistoryRecords.clientId, payload.clientId),
            eq(schema.aiHistoryRecords.userKey, payload.userKey)
          )
        )
        .limit(1);
      const actorUserId = await this.getExistingActorUserId(actor.userId);
      const created = !existingRecord;

      const [savedRecord] = await this.databaseService.db
        .insert(schema.aiHistoryRecords)
        .values({
          clientId: payload.clientId,
          userKey: payload.userKey,
          ...encrypted,
          updatedByUserId: actorUserId
        })
        .onConflictDoUpdate({
          target: [schema.aiHistoryRecords.clientId, schema.aiHistoryRecords.userKey],
          set: {
            ...encrypted,
            updatedByUserId: actorUserId,
            updatedAt: new Date()
          }
        })
        .returning({ id: schema.aiHistoryRecords.id });

      const messageCount = sessions.reduce(
        (total, session) => total + session.messages.length,
        0
      );

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId,
        action: "ai_history.saved",
        entityType: "ai_history_record",
        entityId: savedRecord.id,
        details: {
          sessionCount: sessions.length,
          messageCount
        }
      });

      return {
        clientId: payload.clientId,
        userKey: payload.userKey,
        sessionCount: sessions.length,
        messageCount,
        created
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to save AI history", {
        cause: error
      });
    }
  }

  private assertCanUseHistory(
    clientId: string,
    userKey: string,
    actor: RequestUser
  ): void {
    if (
      (actor.roleCode === ROLE_CODES.clientAdmin || actor.roleCode === ROLE_CODES.employee) &&
      actor.clientId !== clientId
    ) {
      throw new ForbiddenException("User cannot use AI history from another client");
    }

    if (actor.roleCode === ROLE_CODES.employee) {
      const employeeStorageKey = `emp_${actor.userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

      if (userKey !== actor.userId && userKey !== employeeStorageKey) {
        throw new ForbiddenException("Employee cannot use another user's AI history");
      }
    }
  }

  private normalizeSessions(value: unknown): AiHistorySession[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException("sessions must be an array");
    }

    if (value.length > this.maxSessions) {
      throw new BadRequestException(`AI history cannot contain more than ${this.maxSessions} sessions`);
    }

    const sessions = value.map((item, sessionIndex) =>
      this.normalizeSession(item, sessionIndex)
    );
    const serializedSize = Buffer.byteLength(JSON.stringify(sessions), "utf8");

    if (serializedSize > this.maxSerializedBytes) {
      throw new BadRequestException("AI history is larger than 5 MB");
    }

    return sessions;
  }

  private normalizeSession(value: unknown, sessionIndex: number): AiHistorySession {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(`Session ${sessionIndex + 1} must be an object`);
    }

    const session = value as Record<string, unknown>;
    const id = this.requireString(session.id, `Session ${sessionIndex + 1} id`, 200);
    const title = this.requireString(
      session.title,
      `Session ${sessionIndex + 1} title`,
      300,
      true
    );

    if (!Number.isFinite(session.updatedAt)) {
      throw new BadRequestException(`Session ${sessionIndex + 1} updatedAt must be a number`);
    }

    if (!Array.isArray(session.messages)) {
      throw new BadRequestException(`Session ${sessionIndex + 1} messages must be an array`);
    }

    if (session.messages.length > this.maxMessagesPerSession) {
      throw new BadRequestException(
        `Session ${sessionIndex + 1} cannot contain more than ${this.maxMessagesPerSession} messages`
      );
    }

    if (session.isPinned !== undefined && typeof session.isPinned !== "boolean") {
      throw new BadRequestException(`Session ${sessionIndex + 1} isPinned must be boolean`);
    }

    return {
      id,
      title,
      messages: session.messages.map((message, messageIndex) =>
        this.normalizeMessage(message, sessionIndex, messageIndex)
      ),
      updatedAt: session.updatedAt as number,
      ...(session.isPinned === undefined ? {} : { isPinned: session.isPinned })
    };
  }

  private normalizeMessage(
    value: unknown,
    sessionIndex: number,
    messageIndex: number
  ): AiHistoryMessage {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(
        `Message ${messageIndex + 1} in session ${sessionIndex + 1} must be an object`
      );
    }

    const message = value as Record<string, unknown>;

    if (message.role !== "user" && message.role !== "ai") {
      throw new BadRequestException(
        `Message ${messageIndex + 1} in session ${sessionIndex + 1} has an invalid role`
      );
    }

    return {
      id: this.requireString(message.id, "Message id", 200),
      role: message.role,
      content: this.requireString(message.content, "Message content", 50_000, true),
      timestamp: this.requireString(message.timestamp, "Message timestamp", 100, true)
    };
  }

  private requireString(
    value: unknown,
    fieldName: string,
    maxLength: number,
    allowEmpty = false
  ): string {
    if (typeof value !== "string") {
      throw new BadRequestException(`${fieldName} must be a string`);
    }

    if (!allowEmpty && value.trim().length === 0) {
      throw new BadRequestException(`${fieldName} cannot be empty`);
    }

    if (value.length > maxLength) {
      throw new BadRequestException(`${fieldName} is too long`);
    }

    return value;
  }

  private async getExistingActorUserId(
    value: string | null | undefined
  ): Promise<string | undefined> {
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
