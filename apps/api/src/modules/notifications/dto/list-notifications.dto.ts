import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class ListNotificationsDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;
}
