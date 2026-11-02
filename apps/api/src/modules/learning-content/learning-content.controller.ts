import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ListLearningContentDto } from "./dto/list-learning-content.dto";
import { SyncLegacyRouteDto } from "./dto/sync-legacy-route.dto";
import { SyncLegacyTestsDto } from "./dto/sync-legacy-tests.dto";
import { LearningContentService } from "./learning-content.service";

@Controller("learning-content")
export class LearningContentController {
  constructor(private readonly learningContentService: LearningContentService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listLearningContent(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListLearningContentDto
  ): Promise<unknown> {
    return this.learningContentService.listLearningContentForActor(query, currentUser);
  }

  @Get("legacy-route")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listLegacyRoute(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListLearningContentDto
  ): Promise<unknown> {
    return this.learningContentService.listLegacyRouteForActor(query, currentUser);
  }

  @Get("legacy-tests")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listLegacyTests(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListLearningContentDto
  ): Promise<unknown> {
    return this.learningContentService.listLegacyTestsForActor(query, currentUser);
  }

  @Post("legacy-route")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async syncLegacyRoute(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: SyncLegacyRouteDto
  ): Promise<unknown> {
    return this.learningContentService.syncLegacyRouteForActor(payload, currentUser);
  }

  @Post("legacy-tests")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async syncLegacyTests(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: SyncLegacyTestsDto
  ): Promise<unknown> {
    return this.learningContentService.syncLegacyTestsForActor(payload, currentUser);
  }
}
