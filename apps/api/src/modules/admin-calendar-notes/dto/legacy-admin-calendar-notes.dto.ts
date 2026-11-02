import { Allow, IsUUID } from "class-validator";

export class LegacyGetAdminCalendarNotesDto {
  @IsUUID()
  clientId!: string;
}

export class LegacySyncAdminCalendarNotesDto extends LegacyGetAdminCalendarNotesDto {
  @Allow()
  notes!: unknown;
}
