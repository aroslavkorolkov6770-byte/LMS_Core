import { Allow, IsArray, IsUUID } from "class-validator";

export class SyncLegacyTestsDto {
  @IsUUID()
  clientId!: string;

  @IsArray()
  @Allow()
  items!: unknown[];
}
