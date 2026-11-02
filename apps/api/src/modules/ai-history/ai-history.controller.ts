import { Body, Controller, Get, Post, Query } from "@nestjs/common";

import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import {
  LegacyGetAiHistoryDto,
  LegacySaveAiHistoryDto
} from "./dto/legacy-ai-history.dto";
import { AiHistoryService } from "./ai-history.service";

@Controller("ai-history")
export class AiHistoryController {
  constructor(private readonly aiHistoryService: AiHistoryService) {}

  @Get("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async getLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyGetAiHistoryDto
  ): Promise<unknown> {
    return this.aiHistoryService.getLegacyForActor(query, currentUser);
  }

  @Post("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async saveLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySaveAiHistoryDto
  ): Promise<unknown> {
    return this.aiHistoryService.saveLegacyForActor(payload, currentUser);
  }
}
