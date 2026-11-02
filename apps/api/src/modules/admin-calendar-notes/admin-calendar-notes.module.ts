import { Module } from "@nestjs/common";

import { AdminCalendarNotesController } from "./admin-calendar-notes.controller";
import { AdminCalendarNotesService } from "./admin-calendar-notes.service";

@Module({
  controllers: [AdminCalendarNotesController],
  providers: [AdminCalendarNotesService]
})
export class AdminCalendarNotesModule {}
