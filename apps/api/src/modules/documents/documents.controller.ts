import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { CurrentUser, RequestUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { CreateDocumentDto } from "./dto/create-document.dto";
import { DocumentMutationDto } from "./dto/document-mutation.dto";
import { LegacySyncDocumentsDto } from "./dto/legacy-sync-documents.dto";
import { ListDocumentsDto } from "./dto/list-documents.dto";
import { UpdateDocumentDto } from "./dto/update-document.dto";
import { DocumentsService } from "./documents.service";

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listDocuments(@Query() query: ListDocumentsDto): Promise<{
    items: Array<unknown>;
  }> {
    return this.documentsService.listDocumentsForActor(
      query,
      {
        userId: "system-process",
        clientId: "",
        roleCode: ROLE_CODES.systemAdmin
      }
    );
  }

  @Get("scoped")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async listScopedDocuments(
    @CurrentUser() currentUser: RequestUser,
    @Query() query: ListDocumentsDto
  ): Promise<{
    items: Array<unknown>;
  }> {
    return this.documentsService.listDocumentsForActor(query, currentUser);
  }

  @Get("meta")
  getMeta(): { module: string; status: string; scopedRoute: string } {
    return this.documentsService.getMeta();
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async createDocument(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: CreateDocumentDto
  ): Promise<{
    item: unknown;
  }> {
    return this.documentsService.createDocumentForActor(payload, currentUser);
  }

  @Post("legacy-sync")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async legacySync(
    @CurrentUser() currentUser: RequestUser,
    @Body() payload: LegacySyncDocumentsDto
  ): Promise<unknown> {
    return this.documentsService.syncLegacyForActor(payload, currentUser);
  }

  @Patch(":documentId")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async updateDocument(
    @CurrentUser() currentUser: RequestUser,
    @Param("documentId") documentId: string,
    @Body() payload: UpdateDocumentDto
  ): Promise<{ item: unknown }> {
    return this.documentsService.updateDocumentForActor(documentId, payload, currentUser);
  }

  @Delete(":documentId")
  @Roles(ROLE_CODES.systemAdmin, ROLE_CODES.clientAdmin)
  async deleteDocument(
    @CurrentUser() currentUser: RequestUser,
    @Param("documentId") documentId: string,
    @Query() query: DocumentMutationDto
  ): Promise<{ deleted: boolean }> {
    return this.documentsService.deleteDocumentForActor(documentId, query, currentUser);
  }
}
