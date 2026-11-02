import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class AskAiDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  question!: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;
}
