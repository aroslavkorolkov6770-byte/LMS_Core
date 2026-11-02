import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import {
  LegacyGetDismissedTasksDto,
  LegacySyncDismissedTasksDto
} from "./dto/legacy-dismissed-tasks.dto";
import { DismissedTasksService } from "./dismissed-tasks.service";

@Controller("dismissed-tasks")
export class DismissedTasksController {
  constructor(private readonly dismissedTasksService: DismissedTasksService) {}

  @Get("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async getLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyGetDismissedTasksDto
  ): Promise<{ clientId: string; userKey: string; taskKeys: string[]; exists: boolean }> {
    return this.dismissedTasksService.getLegacyForActor(query, currentUser);
  }

  @Post("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async syncLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncDismissedTasksDto
  ): Promise<{ clientId: string; userKey: string; taskKeys: string[]; created: boolean }> {
    return this.dismissedTasksService.syncLegacyForActor(payload, currentUser);
  }
}
