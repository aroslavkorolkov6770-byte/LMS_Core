import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import {
  LegacyGetAdminCalendarNotesDto,
  LegacySyncAdminCalendarNotesDto
} from "./dto/legacy-admin-calendar-notes.dto";
import { AdminCalendarNotesService } from "./admin-calendar-notes.service";

@Controller("admin-calendar-notes")
export class AdminCalendarNotesController {
  constructor(private readonly adminCalendarNotesService: AdminCalendarNotesService) {}

  @Get("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async getLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyGetAdminCalendarNotesDto
  ): Promise<{ clientId: string; notes: Record<string, string> }> {
    return this.adminCalendarNotesService.getLegacyForActor(query, currentUser);
  }

  @Post("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async syncLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncAdminCalendarNotesDto
  ): Promise<{ clientId: string; total: number; created: number; updated: number; deleted: number }> {
    return this.adminCalendarNotesService.syncLegacyForActor(payload, currentUser);
  }
}
