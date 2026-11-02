import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { GetClientContentDto } from "./dto/get-client-content.dto";
import { ImportClientSeedDto } from "./dto/import-client-seed.dto";
import { ListAdminAuditDto } from "./dto/list-admin-audit.dto";
import { UpsertClientContentDto } from "./dto/upsert-client-content.dto";
import { AdminOpsService } from "./admin-ops.service";

@Controller("admin-ops")
export class AdminOpsController {
  constructor(private readonly adminOpsService: AdminOpsService) {}

  @Get("meta")
  getMeta(): { module: string; status: string; auditRoute: string } {
    return this.adminOpsService.getMeta();
  }

  @Get("audit-recent")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listRecentAudit(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListAdminAuditDto
  ): Promise<unknown> {
    return this.adminOpsService.listRecentAuditForActor(query, currentUser);
  }

  @Post("import-client-seed")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async importClientSeed(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: ImportClientSeedDto
  ): Promise<unknown> {
    return this.adminOpsService.importClientSeedForActor(payload, currentUser);
  }

  @Get("client-content")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async getClientContent(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: GetClientContentDto
  ): Promise<unknown> {
    return this.adminOpsService.getClientContentForActor(query, currentUser);
  }

  @Post("client-content")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async upsertClientContent(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: UpsertClientContentDto
  ): Promise<unknown> {
    return this.adminOpsService.upsertClientContentForActor(payload, currentUser);
  }
}
