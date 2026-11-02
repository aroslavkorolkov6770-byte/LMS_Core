import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { AcknowledgementsService } from "./acknowledgements.service";
import { CreateAcknowledgementDto } from "./dto/create-acknowledgement.dto";
import { ListAcknowledgementsDto } from "./dto/list-acknowledgements.dto";

@Controller("acknowledgements")
export class AcknowledgementsController {
  constructor(private readonly acknowledgementsService: AcknowledgementsService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listAcknowledgements(@Query() query: ListAcknowledgementsDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.acknowledgementsService.listAcknowledgementsForActor(query, {
      userId: "system-process",
      clientId: "",
      roleCode: ROLE_CODES.systemAdmin
    });
  }

  @Get("scoped")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async listScopedAcknowledgements(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListAcknowledgementsDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.acknowledgementsService.listAcknowledgementsForActor(query, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; scopedRoute: string } {
    return this.acknowledgementsService.getMeta();
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async createAcknowledgement(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: CreateAcknowledgementDto
  ): Promise<{
    item: unknown;
  }> {
    return this.acknowledgementsService.createAcknowledgementForActor(
      payload,
      currentUser
    );
  }
}
