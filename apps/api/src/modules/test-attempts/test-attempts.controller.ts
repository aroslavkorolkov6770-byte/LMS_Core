import { Body, Controller, Get, Post, Query } from "@nestjs/common";

import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { LegacyListTestAttemptsDto } from "./dto/legacy-list-test-attempts.dto";
import { LegacyListPassedTestsDto } from "./dto/legacy-list-passed-tests.dto";
import { LegacySyncPassedTestsDto } from "./dto/legacy-sync-passed-tests.dto";
import { LegacySyncTestResultsDto } from "./dto/legacy-sync-test-results.dto";
import { TestAttemptsService } from "./test-attempts.service";

@Controller("test-attempts")
export class TestAttemptsController {
  constructor(private readonly testAttemptsService: TestAttemptsService) {}

  @Get("legacy-results")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listLegacyResults(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyListTestAttemptsDto
  ): Promise<{ items: Array<unknown> }> {
    return this.testAttemptsService.listLegacyResultsForActor(query, currentUser);
  }

  @Get("legacy-passed")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listLegacyPassed(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyListPassedTestsDto
  ): Promise<{ passedTestSlugs: string[] }> {
    return this.testAttemptsService.listLegacyPassedForActor(query, currentUser);
  }

  @Post("legacy-results")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async syncLegacyResults(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncTestResultsDto
  ): Promise<{ total: number; created: number; updated: number; skipped: number }> {
    return this.testAttemptsService.syncLegacyResultsForActor(payload, currentUser);
  }

  @Post("legacy-passed")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async syncLegacyPassed(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncPassedTestsDto
  ): Promise<{ passedTestSlugs: string[]; created: number; existing: number }> {
    return this.testAttemptsService.syncLegacyPassedForActor(payload, currentUser);
  }
}
