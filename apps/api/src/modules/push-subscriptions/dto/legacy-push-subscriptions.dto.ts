import { Transform } from "class-transformer";
import { Allow, IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class LegacyListPushSubscriptionsDto {
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  limit?: number;
}

export class LegacySyncPushSubscriptionsDto {
  @IsUUID()
  clientId!: string;

  @Allow()
  items!: unknown;
}

export type LegacyPushSubscriptionItem = {
  userId: string;
  sub: unknown;
};
