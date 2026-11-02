import { Allow, IsNotEmpty, IsString, IsUUID, MaxLength } from "class-validator";

export class LegacyGetAiHistoryDto {
  @IsUUID()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  userKey!: string;
}

export class LegacySaveAiHistoryDto extends LegacyGetAiHistoryDto {
  @Allow()
  sessions!: unknown;
}
