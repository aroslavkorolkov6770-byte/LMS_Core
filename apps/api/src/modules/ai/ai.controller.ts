import { Body, Controller, Get, Post } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { AiService } from "./ai.service";
import { AskAiDto } from "./dto/ask-ai.dto";

@Controller("ai")
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get("meta")
  getMeta(): { module: string; status: string; askRoute: string; rule: string } {
    return this.aiService.getMeta();
  }

  @Post("ask")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async ask(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: AskAiDto
  ): Promise<unknown> {
    return this.aiService.askForActor(payload, currentUser);
  }
}
