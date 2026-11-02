import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { DatabaseModule } from "../database/database.module";
import { AdminOpsController } from "./admin-ops.controller";
import { AdminOpsService } from "./admin-ops.service";

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [AdminOpsController],
  providers: [AdminOpsService]
})
export class AdminOpsModule {}
