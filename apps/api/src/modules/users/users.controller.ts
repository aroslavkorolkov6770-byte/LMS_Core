import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { CreateUserDto } from "./dto/create-user.dto";
import { LegacyLoginDto } from "./dto/legacy-login.dto";
import { LegacyRegisterDto } from "./dto/legacy-register.dto";
import { LegacySyncUsersDto } from "./dto/legacy-sync-users.dto";
import { ListUsersDto } from "./dto/list-users.dto";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listUsers(@Query() query: ListUsersDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.usersService.listUsers(query);
  }

  @Get("scoped")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listScopedUsers(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListUsersDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.usersService.listUsersForActor(query, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; roles: string[] } {
    return this.usersService.getMeta();
  }

  @Get("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listLegacyUsers(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListUsersDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.usersService.listLegacyUsersForActor(query, currentUser);
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async createUser(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: CreateUserDto
  ): Promise<{
    item: unknown;
  }> {
    return this.usersService.createUserForActor(payload, currentUser);
  }

  @Post("legacy-login")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async legacyLogin(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacyLoginDto
  ): Promise<{
    user: unknown;
  }> {
    return this.usersService.legacyLoginForActor(payload, currentUser);
  }

  @Post("legacy-register")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async legacyRegister(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacyRegisterDto
  ): Promise<{
    user: unknown;
  }> {
    return this.usersService.legacyRegisterForActor(payload, currentUser);
  }

  @Post("legacy-sync")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async legacySync(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncUsersDto
  ): Promise<{
    total: number;
    created: number;
    updated: number;
    skipped: number;
  }> {
    return this.usersService.legacySyncUsersForActor(payload, currentUser);
  }
}
