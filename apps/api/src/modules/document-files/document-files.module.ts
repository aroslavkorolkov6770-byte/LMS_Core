import { Module } from "@nestjs/common";

import { DocumentFileCryptoService } from "./document-file-crypto.service";
import { DocumentFilesController } from "./document-files.controller";
import { DocumentFilesService } from "./document-files.service";

@Module({
  controllers: [DocumentFilesController],
  providers: [DocumentFileCryptoService, DocumentFilesService],
  exports: [DocumentFilesService]
})
export class DocumentFilesModule {}
