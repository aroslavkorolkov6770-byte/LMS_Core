import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { CreateDeadlineDto } from "./dto/create-deadline.dto";
import { ListDeadlinesDto } from "./dto/list-deadlines.dto";
import { DeadlinesService } from "./deadlines.service";

@Controller("deadlines")
export class DeadlinesController {
  constructor(private readonly deadlinesService: DeadlinesService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listDeadlines(@Query() query: ListDeadlinesDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.deadlinesService.listDeadlinesForActor(query, {
      userId: "system-process",
      clientId: "",
      roleCode: ROLE_CODES.systemAdmin
    });
  }

  @Get("scoped")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listScopedDeadlines(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListDeadlinesDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.deadlinesService.listDeadlinesForActor(query, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; scopedRoute: string } {
    return this.deadlinesService.getMeta();
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async createDeadline(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: CreateDeadlineDto
  ): Promise<{
    item: unknown;
  }> {
    return this.deadlinesService.createDeadlineForActor(payload, currentUser);
  }
}
