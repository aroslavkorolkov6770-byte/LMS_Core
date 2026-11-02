import { Transform } from "class-transformer";
import { IsBoolean, IsOptional, IsUUID } from "class-validator";

export class ImportClientSeedDto {
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  resetExisting?: boolean;
}
