import { Transform } from "class-transformer";
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class LegacyListNotificationsDto {
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;
}

export class LegacySyncNotificationsDto {
  @IsUUID()
  clientId!: string;

  @IsArray()
  items!: unknown[];
}

export type LegacyNotificationItem = {
  id: string;
  title: string;
  text: string;
  time: string;
  target: string;
};
