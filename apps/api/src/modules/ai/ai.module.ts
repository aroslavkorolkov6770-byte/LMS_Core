import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [AiController],
  providers: [AiService]
})
export class AiModule {}
