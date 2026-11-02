import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { CreateTestDto } from "./dto/create-test.dto";
import { ListTestsDto } from "./dto/list-tests.dto";
import { TestsService } from "./tests.service";

@Controller("tests")
export class TestsController {
  constructor(private readonly testsService: TestsService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listTests(@Query() query: ListTestsDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.testsService.listTestsForActor(query, {
      userId: "system-process",
      clientId: "",
      roleCode: ROLE_CODES.systemAdmin
    });
  }

  @Get("scoped")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listScopedTests(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListTestsDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.testsService.listTestsForActor(query, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; scopedRoute: string } {
    return this.testsService.getMeta();
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async createTest(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: CreateTestDto
  ): Promise<{
    item: unknown;
  }> {
    return this.testsService.createTestForActor(payload, currentUser);
  }
}
