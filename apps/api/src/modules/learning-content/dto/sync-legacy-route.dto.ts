import { Allow, IsArray, IsUUID } from "class-validator";

export class SyncLegacyRouteDto {
  @IsUUID()
  clientId!: string;

  @IsArray()
  @Allow()
  items!: unknown[];
}
