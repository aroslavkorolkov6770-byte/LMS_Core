import { IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

export const DEADLINE_STATUSES = ["active", "completed", "overdue"] as const;

export class CreateDeadlineDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  userId!: string;

  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsUUID()
  testId?: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsDateString()
  dueAt!: string;

  @IsOptional()
  @IsIn(DEADLINE_STATUSES)
  status?: string;
}
