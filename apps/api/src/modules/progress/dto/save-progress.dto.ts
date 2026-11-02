import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";

export const PROGRESS_STATUSES = [
  "not_started",
  "in_progress",
  "completed"
] as const;

export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export class SaveProgressDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  userId!: string;

  @IsUUID()
  courseId!: string;

  @IsOptional()
  @IsUUID()
  lastTestId?: string;

  @IsIn(PROGRESS_STATUSES)
  status!: ProgressStatus;

  @IsInt()
  @Min(0)
  @Max(100)
  completionPercent!: number;
}
