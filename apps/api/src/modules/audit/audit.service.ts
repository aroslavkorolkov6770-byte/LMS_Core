import { Injectable, InternalServerErrorException } from "@nestjs/common";

import { schema } from "@lms-core/db";

import { DatabaseService } from "../database/database.service";
import { WriteAuditLogDto } from "./dto/write-audit-log.dto";

@Injectable()
export class AuditService {
  constructor(private readonly databaseService: DatabaseService) {}

  async writeLog(payload: WriteAuditLogDto): Promise<void> {
    try {
      await this.databaseService.db.insert(schema.auditLog).values({
        clientId: payload.clientId,
        actorUserId: payload.actorUserId,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        details: payload.details
      });
    } catch (error) {
      throw new InternalServerErrorException("Failed to write audit log", {
        cause: error
      });
    }
  }
}
