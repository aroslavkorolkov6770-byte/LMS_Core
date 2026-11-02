import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ClientsService } from "./clients.service";
import { ClientFeaturesDto } from "./dto/client-features.dto";
import { CreateClientDto } from "./dto/create-client.dto";
import { ListClientsDto } from "./dto/list-clients.dto";

@Controller("clients")
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin)
  async listClients(@Query() query: ListClientsDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.clientsService.listClients(query);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; dbConnected: boolean } {
    return this.clientsService.getMeta();
  }

  @Get("features")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async getClientFeatures(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ClientFeaturesDto
  ): Promise<unknown> {
    return this.clientsService.getClientFeaturesForActor(query, currentUser);
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin)
  async createClient(@Body() payload: CreateClientDto): Promise<{
    item: unknown;
  }> {
    return this.clientsService.createClient(payload);
  }
}
