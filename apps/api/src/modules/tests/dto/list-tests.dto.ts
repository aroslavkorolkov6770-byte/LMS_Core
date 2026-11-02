import { Transform } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class ListTestsDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;
}
