import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { UserResponse, toUserResponse } from "../users/users.presenter";
import { ExportClientDto } from "./dto/export-client.dto";

type ClientExportResponse = {
  exportedAt: string;
  client: typeof schema.clients.$inferSelect;
  users: UserResponse[];
  courses: Array<typeof schema.courses.$inferSelect>;
  tests: Array<typeof schema.tests.$inferSelect>;
  documents: Array<typeof schema.documents.$inferSelect>;
  progress: Array<typeof schema.progress.$inferSelect>;
  deadlines: Array<typeof schema.deadlines.$inferSelect>;
  acknowledgements: Array<typeof schema.acknowledgements.$inferSelect>;
  notifications: Array<typeof schema.notifications.$inferSelect>;
};

@Injectable()
export class ExportsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async exportClientSnapshotForActor(
    query: ExportClientDto,
    actor: RequestUser
  ): Promise<ClientExportResponse> {
    try {
      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        query.clientId !== actor.clientId
      ) {
        throw new ForbiddenException("Client admin cannot export another client");
      }

      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, query.clientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      const [rawUsers, courses, tests, documents, progress, deadlines, acknowledgements, notifications] =
        await Promise.all([
          this.databaseService.db
            .select()
            .from(schema.users)
            .where(eq(schema.users.clientId, query.clientId)),
          this.databaseService.db
            .select()
            .from(schema.courses)
            .where(eq(schema.courses.clientId, query.clientId)),
          this.databaseService.db
            .select()
            .from(schema.tests)
            .where(eq(schema.tests.clientId, query.clientId)),
          this.databaseService.db
            .select()
            .from(schema.documents)
            .where(eq(schema.documents.clientId, query.clientId)),
          this.databaseService.db
            .select()
            .from(schema.progress)
            .where(eq(schema.progress.clientId, query.clientId)),
          this.databaseService.db
            .select()
            .from(schema.deadlines)
            .where(eq(schema.deadlines.clientId, query.clientId)),
          this.databaseService.db
            .select()
            .from(schema.acknowledgements)
            .where(eq(schema.acknowledgements.clientId, query.clientId)),
          this.databaseService.db
            .select()
            .from(schema.notifications)
            .where(eq(schema.notifications.clientId, query.clientId))
        ]);

      const users = rawUsers.map((user) => toUserResponse(user));

      await this.auditService.writeLog({
        clientId: query.clientId,
        actorUserId: actor.userId,
        action: "export.client_snapshot",
        entityType: "export",
        entityId: query.clientId,
        details: {
          users: users.length,
          courses: courses.length,
          tests: tests.length,
          documents: documents.length,
          progress: progress.length,
          deadlines: deadlines.length,
          acknowledgements: acknowledgements.length,
          notifications: notifications.length
        }
      });

      return {
        exportedAt: new Date().toISOString(),
        client,
        users,
        courses,
        tests,
        documents,
        progress,
        deadlines,
        acknowledgements,
        notifications
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to export client snapshot", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; exportRoute: string } {
    return {
      module: "exports",
      status: "active",
      exportRoute: "/api/exports/client-snapshot"
    };
  }
}
