import { Allow, IsUUID } from "class-validator";

export class LegacySyncDocumentsDto {
  @IsUUID()
  clientId!: string;

  @Allow()
  items!: unknown;
}
