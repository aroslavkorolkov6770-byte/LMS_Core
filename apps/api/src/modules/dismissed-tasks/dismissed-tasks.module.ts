import { Module } from "@nestjs/common";

import { DismissedTasksController } from "./dismissed-tasks.controller";
import { DismissedTasksService } from "./dismissed-tasks.service";

@Module({
  controllers: [DismissedTasksController],
  providers: [DismissedTasksService]
})
export class DismissedTasksModule {}
