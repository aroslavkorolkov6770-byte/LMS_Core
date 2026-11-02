import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

const NOTIFICATION_CHANNELS = ["in_app", "email", "push"] as const;
const NOTIFICATION_STATUSES = ["unread", "read"] as const;

export class CreateNotificationDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  userId!: string;

  @IsOptional()
  @IsUUID()
  deadlineId?: string;

  @IsOptional()
  @IsUUID()
  documentId?: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  message!: string;

  @IsOptional()
  @IsIn(NOTIFICATION_CHANNELS)
  channel?: string;

  @IsOptional()
  @IsIn(NOTIFICATION_STATUSES)
  status?: string;
}
