import { Allow, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";

export class CreateCourseDto {
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  slug!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  contentKind?: string;

  @IsOptional()
  @Allow()
  content?: unknown;

  @IsOptional()
  @IsString()
  roleLabel?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  orderIndex?: number;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}
