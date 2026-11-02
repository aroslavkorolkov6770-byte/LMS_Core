import { IsUUID } from "class-validator";

export class LegacyListPassedTestsDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  userId!: string;
}
