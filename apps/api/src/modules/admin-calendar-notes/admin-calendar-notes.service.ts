import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { and, asc, eq, notInArray } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import {
  LegacyGetAdminCalendarNotesDto,
  LegacySyncAdminCalendarNotesDto
} from "./dto/legacy-admin-calendar-notes.dto";

type NormalizedAdminCalendarNote = {
  dateKey: string;
  noteText: string;
};

@Injectable()
export class AdminCalendarNotesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async getLegacyForActor(
    query: LegacyGetAdminCalendarNotesDto,
    actor: RequestUser
  ): Promise<{ clientId: string; notes: Record<string, string> }> {
    try {
      this.assertCanUseClient(query.clientId, actor);

      const rows = await this.databaseService.db
        .select({
          dateKey: schema.adminCalendarNotes.dateKey,
          noteText: schema.adminCalendarNotes.noteText
        })
        .from(schema.adminCalendarNotes)
        .where(eq(schema.adminCalendarNotes.clientId, query.clientId))
        .orderBy(asc(schema.adminCalendarNotes.dateKey));

      return {
        clientId: query.clientId,
        notes: Object.fromEntries(rows.map((row) => [row.dateKey, row.noteText]))
      };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load admin calendar notes", {
        cause: error
      });
    }
  }

  async syncLegacyForActor(
    payload: LegacySyncAdminCalendarNotesDto,
    actor: RequestUser
  ): Promise<{ clientId: string; total: number; created: number; updated: number; deleted: number }> {
    try {
      this.assertCanUseClient(payload.clientId, actor);
      const normalizedNotes = this.normalizeLegacyNotes(payload.notes);

      const [client] = await this.databaseService.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, payload.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const actorUserId = await this.getExistingActorUserId(actor.userId);
      const result = await this.databaseService.db.transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(schema.adminCalendarNotes)
          .where(eq(schema.adminCalendarNotes.clientId, payload.clientId));
        const existingByDateKey = new Map(existingRows.map((row) => [row.dateKey, row]));
        const incomingDateKeys = normalizedNotes.map((note) => note.dateKey);

        const deletedRows = incomingDateKeys.length > 0
          ? await tx
              .delete(schema.adminCalendarNotes)
              .where(
                and(
                  eq(schema.adminCalendarNotes.clientId, payload.clientId),
                  notInArray(schema.adminCalendarNotes.dateKey, incomingDateKeys)
                )
              )
              .returning({ id: schema.adminCalendarNotes.id })
          : await tx
              .delete(schema.adminCalendarNotes)
              .where(eq(schema.adminCalendarNotes.clientId, payload.clientId))
              .returning({ id: schema.adminCalendarNotes.id });

        let created = 0;
        let updated = 0;

        for (const note of normalizedNotes) {
          const existing = existingByDateKey.get(note.dateKey);

          if (existing) {
            await tx
              .update(schema.adminCalendarNotes)
              .set({
                noteText: note.noteText,
                updatedByUserId: actorUserId,
                updatedAt: new Date()
              })
              .where(eq(schema.adminCalendarNotes.id, existing.id));
            updated += 1;
            continue;
          }

          await tx.insert(schema.adminCalendarNotes).values({
            clientId: payload.clientId,
            dateKey: note.dateKey,
            noteText: note.noteText,
            updatedByUserId: actorUserId
          });
          created += 1;
        }

        return {
          created,
          updated,
          deleted: deletedRows.length
        };
      });

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId,
        action: "admin_calendar_notes.synced",
        entityType: "admin_calendar_notes",
        entityId: payload.clientId,
        details: {
          total: normalizedNotes.length,
          created: result.created,
          updated: result.updated,
          deleted: result.deleted
        }
      });

      return {
        clientId: payload.clientId,
        total: normalizedNotes.length,
        ...result
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to sync admin calendar notes", {
        cause: error
      });
    }
  }

  private assertCanUseClient(clientId: string, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.employee) {
      throw new ForbiddenException("Employee cannot use admin calendar notes");
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && clientId !== actor.clientId) {
      throw new ForbiddenException("Client admin cannot use another client's calendar notes");
    }
  }

  private normalizeLegacyNotes(value: unknown): NormalizedAdminCalendarNote[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("notes must be an object");
    }

    const normalizedNotes: NormalizedAdminCalendarNote[] = [];

    for (const [dateKey, noteTextValue] of Object.entries(value)) {
      this.assertValidLegacyDateKey(dateKey);

      if (typeof noteTextValue !== "string") {
        throw new BadRequestException(`Calendar note ${dateKey} must be a string`);
      }

      const noteText = noteTextValue.trim();

      if (!noteText) {
        continue;
      }

      if (noteText.length > 10_000) {
        throw new BadRequestException(`Calendar note ${dateKey} is too long`);
      }

      normalizedNotes.push({ dateKey, noteText });
    }

    return normalizedNotes;
  }

  private assertValidLegacyDateKey(dateKey: string): void {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateKey);

    if (!match) {
      throw new BadRequestException(`Invalid calendar date key: ${dateKey}`);
    }

    const monthIndex = Number(match[2]);
    const day = Number(match[3]);

    if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) {
      throw new BadRequestException(`Invalid calendar date key: ${dateKey}`);
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
