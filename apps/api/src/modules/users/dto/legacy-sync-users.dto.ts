import { Allow, IsUUID } from "class-validator";

export class LegacySyncUsersDto {
  @IsUUID()
  clientId!: string;

  @Allow()
  users!: unknown;
}
