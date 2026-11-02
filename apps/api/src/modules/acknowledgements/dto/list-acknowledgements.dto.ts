import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class ListAcknowledgementsDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  documentId?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;
}
