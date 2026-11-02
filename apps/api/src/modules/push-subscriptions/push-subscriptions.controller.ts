import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import {
  LegacyListPushSubscriptionsDto,
  LegacyPushSubscriptionItem,
  LegacySyncPushSubscriptionsDto
} from "./dto/legacy-push-subscriptions.dto";
import { PushSubscriptionsService } from "./push-subscriptions.service";

@Controller("push-subscriptions")
export class PushSubscriptionsController {
  constructor(private readonly pushSubscriptionsService: PushSubscriptionsService) {}

  @Get("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyListPushSubscriptionsDto
  ): Promise<{ items: LegacyPushSubscriptionItem[] }> {
    return this.pushSubscriptionsService.listLegacyForActor(query, currentUser);
  }

  @Post("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async syncLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncPushSubscriptionsDto
  ): Promise<{ total: number; created: number; updated: number; deleted: number; skipped: number }> {
    return this.pushSubscriptionsService.syncLegacyForActor(payload, currentUser);
  }
}
