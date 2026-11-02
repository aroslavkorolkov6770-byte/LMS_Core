import { Allow, IsUUID } from "class-validator";

export class LegacySyncTestResultsDto {
  @IsUUID()
  clientId!: string;

  @Allow()
  results!: unknown;
}
