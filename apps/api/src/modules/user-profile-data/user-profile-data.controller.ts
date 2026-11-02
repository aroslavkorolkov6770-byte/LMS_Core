import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import {
  LegacyGetUserProfileDataDto,
  LegacySaveUserProfileDataDto
} from "./dto/legacy-user-profile-data.dto";
import { UserProfileDataService } from "./user-profile-data.service";

@Controller("user-profile-data")
export class UserProfileDataController {
  constructor(private readonly userProfileDataService: UserProfileDataService) {}

  @Get("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async getLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyGetUserProfileDataDto
  ): Promise<{ clientId: string; userKey: string; payload: unknown | null }> {
    return this.userProfileDataService.getLegacyForActor(query, currentUser);
  }

  @Post("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async saveLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySaveUserProfileDataDto
  ): Promise<{ clientId: string; userKey: string; saved: true }> {
    return this.userProfileDataService.saveLegacyForActor(payload, currentUser);
  }
}
