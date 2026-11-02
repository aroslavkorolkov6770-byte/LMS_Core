import { Controller, Get, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ExportClientDto } from "./dto/export-client.dto";
import { ExportsService } from "./exports.service";

@Controller("exports")
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get("client-snapshot")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async exportClientSnapshot(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ExportClientDto
  ): Promise<unknown> {
    return this.exportsService.exportClientSnapshotForActor(query, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; exportRoute: string } {
    return this.exportsService.getMeta();
  }
}
