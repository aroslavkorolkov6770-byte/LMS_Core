import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { LegacyListProgressDto } from "./dto/legacy-list-progress.dto";
import { LegacySyncProgressDto } from "./dto/legacy-sync-progress.dto";
import { ListProgressDto } from "./dto/list-progress.dto";
import { SaveProgressDto } from "./dto/save-progress.dto";
import { ProgressService } from "./progress.service";

@Controller("progress")
export class ProgressController {
  constructor(private readonly progressService: ProgressService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listProgress(@Query() query: ListProgressDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.progressService.listProgressForActor(query, {
      userId: "system-process",
      clientId: "",
      roleCode: ROLE_CODES.systemAdmin
    });
  }

  @Get("scoped")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listScopedProgress(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListProgressDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.progressService.listProgressForActor(query, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; scopedRoute: string } {
    return this.progressService.getMeta();
  }

  @Get("legacy-route")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listLegacyRouteProgress(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyListProgressDto
  ): Promise<{
    completedRouteSlugs: string[];
  }> {
    return this.progressService.listLegacyRouteProgressForActor(query, currentUser);
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async saveProgress(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: SaveProgressDto
  ): Promise<{
    item: unknown;
  }> {
    return this.progressService.saveProgressForActor(payload, currentUser);
  }

  @Post("legacy-route")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async syncLegacyRouteProgress(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncProgressDto
  ): Promise<{
    completedRouteSlugs: string[];
    created: number;
    updated: number;
  }> {
    return this.progressService.syncLegacyRouteProgressForActor(payload, currentUser);
  }
}
