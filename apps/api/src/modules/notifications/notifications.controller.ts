import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { CreateNotificationDto } from "./dto/create-notification.dto";
import {
  LegacyListNotificationsDto,
  LegacyNotificationItem,
  LegacySyncNotificationsDto
} from "./dto/legacy-notifications.dto";
import { ListNotificationsDto } from "./dto/list-notifications.dto";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listNotifications(@Query() query: ListNotificationsDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.notificationsService.listNotificationsForActor(query, {
      userId: "system-process",
      clientId: "",
      roleCode: ROLE_CODES.systemAdmin
    });
  }

  @Get("scoped")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listScopedNotifications(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListNotificationsDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.notificationsService.listNotificationsForActor(query, currentUser);
  }

  @Get("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listLegacyNotifications(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyListNotificationsDto
  ): Promise<{
    items: LegacyNotificationItem[];
  }> {
    return this.notificationsService.listLegacyNotificationsForActor(query, currentUser);
  }

  @Post("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async syncLegacyNotifications(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncNotificationsDto
  ): Promise<{
    total: number;
    created: number;
    updated: number;
    deleted: number;
    skipped: number;
  }> {
    return this.notificationsService.syncLegacyNotificationsForActor(payload, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; scopedRoute: string } {
    return this.notificationsService.getMeta();
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async createNotification(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: CreateNotificationDto
  ): Promise<{
    item: unknown;
  }> {
    return this.notificationsService.createNotificationForActor(payload, currentUser);
  }
}
