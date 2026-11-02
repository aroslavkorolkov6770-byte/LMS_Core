import { Module } from "@nestjs/common";

import { DocumentFilesModule } from "../document-files/document-files.module";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";

@Module({
  imports: [DocumentFilesModule],
  controllers: [DocumentsController],
  providers: [DocumentsService]
})
export class DocumentsModule {}
