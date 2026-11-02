import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { AiHistoryController } from "./ai-history.controller";
import { AiHistoryCryptoService } from "./ai-history-crypto.service";
import { AiHistoryService } from "./ai-history.service";

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [AiHistoryController],
  providers: [AiHistoryCryptoService, AiHistoryService]
})
export class AiHistoryModule {}
