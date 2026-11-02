import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from "class-validator";

export class LegacyDocumentFileDto {
  @IsUUID()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  fileKey!: string;
}
