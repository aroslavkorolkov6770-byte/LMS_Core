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
import { CreateAcknowledgementDto } from "./dto/create-acknowledgement.dto";
import { ListAcknowledgementsDto } from "./dto/list-acknowledgements.dto";
import {
  AcknowledgementResponse,
  toAcknowledgementResponse
} from "./acknowledgements.presenter";

@Injectable()
export class AcknowledgementsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listAcknowledgementsForActor(
    query: ListAcknowledgementsDto,
    actor: RequestUser
  ): Promise<{ items: AcknowledgementResponse[] }> {
    try {
      const limit = query.limit ?? 20;
      const filters = [];

      if (actor.roleCode === ROLE_CODES.employee) {
        if (query.userId && query.userId !== actor.userId) {
          throw new ForbiddenException("Employee cannot read another user's acknowledgements");
        }

        filters.push(eq(schema.acknowledgements.clientId, actor.clientId));
        filters.push(eq(schema.acknowledgements.userId, actor.userId));
      } else if (actor.roleCode === ROLE_CODES.clientAdmin) {
        if (query.clientId && query.clientId !== actor.clientId) {
          throw new ForbiddenException(
            "Client admin cannot read acknowledgements from another client"
          );
        }

        filters.push(eq(schema.acknowledgements.clientId, actor.clientId));

        if (query.userId) {
          filters.push(eq(schema.acknowledgements.userId, query.userId));
        }
      } else {
        if (query.clientId) {
          filters.push(eq(schema.acknowledgements.clientId, query.clientId));
        }

        if (query.userId) {
          filters.push(eq(schema.acknowledgements.userId, query.userId));
        }
      }

      if (query.documentId) {
        filters.push(eq(schema.acknowledgements.documentId, query.documentId));
      }

      const items = await this.databaseService.db
        .select()
        .from(schema.acknowledgements)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(schema.acknowledgements.acknowledgedAt))
        .limit(limit);

      return { items: items.map(toAcknowledgementResponse) };
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load acknowledgements", {
        cause: error
      });
    }
  }

  async createAcknowledgementForActor(
    payload: CreateAcknowledgementDto,
    actor: RequestUser
  ): Promise<{ item: AcknowledgementResponse }> {
    try {
      if (
        actor.roleCode === ROLE_CODES.clientAdmin &&
        payload.clientId !== actor.clientId
      ) {
        throw new ForbiddenException(
          "Client admin cannot create acknowledgements for another client"
        );
      }

      if (actor.roleCode === ROLE_CODES.employee) {
        if (payload.clientId !== actor.clientId || payload.userId !== actor.userId) {
          throw new ForbiddenException("Employee can acknowledge documents only for self");
        }
      }

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

      const [document] = await this.databaseService.db
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.id, payload.documentId),
            eq(schema.documents.clientId, payload.clientId)
          )
        )
        .limit(1);

      if (!document) {
        throw new NotFoundException("Document not found in the client");
      }

      const [existingItem] = await this.databaseService.db
        .select()
        .from(schema.acknowledgements)
        .where(
          and(
            eq(schema.acknowledgements.userId, payload.userId),
            eq(schema.acknowledgements.documentId, payload.documentId)
          )
        )
        .limit(1);

      if (existingItem) {
        throw new BadRequestException("Acknowledgement for this document already exists");
      }

      const [item] = await this.databaseService.db
        .insert(schema.acknowledgements)
        .values({
          clientId: payload.clientId,
          userId: payload.userId,
          documentId: payload.documentId,
          comment: payload.comment
        })
        .returning();

      await this.auditService.writeLog({
        clientId: payload.clientId,
        actorUserId: actor.userId,
        action: "acknowledgement.created",
        entityType: "acknowledgement",
        entityId: item.id,
        details: {
          userId: item.userId,
          documentId: item.documentId,
          acknowledgedAt: item.acknowledgedAt
        }
      });

      return { item: toAcknowledgementResponse(item) };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to create acknowledgement", {
        cause: error
      });
    }
  }

  getMeta(): { module: string; status: string; scopedRoute: string } {
    return {
      module: "acknowledgements",
      status: "active",
      scopedRoute: "/api/acknowledgements/scoped"
    };
  }
}
