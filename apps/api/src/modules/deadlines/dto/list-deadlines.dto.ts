import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class ListDeadlinesDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;
}
