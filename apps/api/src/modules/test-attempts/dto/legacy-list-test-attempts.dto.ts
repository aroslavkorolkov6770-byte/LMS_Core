import { IsOptional, IsUUID } from "class-validator";

export class LegacyListTestAttemptsDto {
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsUUID()
  userId?: string;
}
