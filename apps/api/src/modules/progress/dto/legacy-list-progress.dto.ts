import { IsUUID } from "class-validator";

export class LegacyListProgressDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  userId!: string;
}
