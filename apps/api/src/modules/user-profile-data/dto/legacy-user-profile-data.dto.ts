import { Allow, IsNotEmpty, IsString, IsUUID, MaxLength } from "class-validator";

export class LegacyGetUserProfileDataDto {
  @IsUUID()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  userKey!: string;
}

export class LegacySaveUserProfileDataDto extends LegacyGetUserProfileDataDto {
  @Allow()
  payload!: unknown;
}
