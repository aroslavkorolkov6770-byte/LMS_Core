import {
  Controller,
  Delete,
  Get,
  Headers,
  Put,
  Query,
  Req,
  Res,
  StreamableFile
} from "@nestjs/common";
import { Readable } from "node:stream";

import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { DocumentFilesService } from "./document-files.service";
import { LegacyDocumentFileDto } from "./dto/legacy-document-file.dto";

type ResponseHeaders = {
  setHeader(name: string, value: string | number): void;
};

@Controller("document-files")
export class DocumentFilesController {
  constructor(private readonly documentFilesService: DocumentFilesService) {}

  @Get("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin, ROLE_CODES.employee)
  async getLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyDocumentFileDto,
    @Res({ passthrough: true }) response: ResponseHeaders
  ): Promise<StreamableFile> {
    const file = await this.documentFilesService.getForActor(query, currentUser);
    response.setHeader("Content-Type", file.mimeType);
    response.setHeader("Content-Length", file.sizeBytes);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");

    return new StreamableFile(file.data);
  }

  @Put("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async putLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyDocumentFileDto,
    @Headers("x-file-mime-type") mimeType: string | undefined,
    @Req() request: Readable
  ): Promise<unknown> {
    return this.documentFilesService.saveForActor(query, mimeType, request, currentUser);
  }

  @Delete("legacy")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async deleteLegacy(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: LegacyDocumentFileDto
  ): Promise<unknown> {
    return this.documentFilesService.deleteForActor(query, currentUser);
  }
}
