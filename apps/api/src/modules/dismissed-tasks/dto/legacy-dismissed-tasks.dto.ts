import { Allow, IsNotEmpty, IsString, IsUUID, MaxLength } from "class-validator";

export class LegacyGetDismissedTasksDto {
  @IsUUID()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  userKey!: string;
}

export class LegacySyncDismissedTasksDto extends LegacyGetDismissedTasksDto {
  @Allow()
  taskKeys!: unknown;
}
