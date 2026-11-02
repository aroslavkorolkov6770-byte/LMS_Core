import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common";
import { desc, eq } from "drizzle-orm";

import { schema } from "@lms-core/db";
import {
  DEFAULT_INDUSTRY_TEMPLATE,
  getTariffFeatures,
  ROLE_CODES,
  TariffFeatures
} from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { ClientFeaturesDto } from "./dto/client-features.dto";
import { CreateClientDto } from "./dto/create-client.dto";
import { ListClientsDto } from "./dto/list-clients.dto";

@Injectable()
export class ClientsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService
  ) {}

  async listClients(query: ListClientsDto): Promise<{
    items: Array<typeof schema.clients.$inferSelect>;
  }> {
    try {
      const limit = query.limit ?? 20;

      const items = await this.databaseService.db
        .select()
        .from(schema.clients)
        .orderBy(desc(schema.clients.createdAt))
        .limit(limit);

      return { items };
    } catch (error) {
      throw new InternalServerErrorException("Failed to load clients", {
        cause: error
      });
    }
  }

  async createClient(payload: CreateClientDto): Promise<{
    item: typeof schema.clients.$inferSelect;
  }> {
    try {
      const defaults = getTariffFeatures(payload.tariff);

      const [item] = await this.databaseService.db
        .insert(schema.clients)
        .values({
          name: payload.name,
          slug: payload.slug,
          domain: payload.domain,
          brandName: payload.brandName,
          primaryColor: payload.primaryColor,
          tariff: payload.tariff,
          industryTemplate: payload.industryTemplate ?? DEFAULT_INDUSTRY_TEMPLATE,
          isActive: payload.isActive ?? true,
          includedUsers: payload.includedUsers ?? defaults.includedUsers,
          maxAdmins: payload.maxAdmins ?? defaults.maxAdmins,
          aiRequestsLimit: payload.aiRequestsLimit
        })
        .returning();

      await this.auditService.writeLog({
        clientId: item.id,
        action: "client.created",
        entityType: "client",
        entityId: item.id,
        details: {
          name: item.name,
          tariff: item.tariff,
          industryTemplate: item.industryTemplate
        }
      });

      return { item };
    } catch (error) {
      throw new InternalServerErrorException("Failed to create client", {
        cause: error
      });
    }
  }

  async getClientFeaturesForActor(
    query: ClientFeaturesDto,
    actor: RequestUser
  ): Promise<{
    clientId: string;
    tariff: string;
    features: TariffFeatures;
  }> {
    try {
      const effectiveClientId =
        actor.roleCode === ROLE_CODES.clientAdmin ? actor.clientId : query.clientId;

      if (actor.roleCode === ROLE_CODES.clientAdmin && query.clientId && query.clientId !== actor.clientId) {
        throw new ForbiddenException("Client admin cannot read features for another client");
      }

      if (!effectiveClientId) {
        throw new NotFoundException("clientId is required");
      }

      const [client] = await this.databaseService.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, effectiveClientId))
        .limit(1);

      if (!client) {
        throw new NotFoundException("Client not found");
      }

      return {
        clientId: client.id,
        tariff: client.tariff,
        features: getTariffFeatures(client.tariff)
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to load client features", {
        cause: error
      });
    }
  }

  getMeta(): {
    module: string;
    status: string;
    dbConnected: boolean;
  } {
    return {
      module: "clients",
      status: "planned",
      dbConnected: Boolean(this.databaseService.db)
    };
  }
}
