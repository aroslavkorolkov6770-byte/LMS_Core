import { IsNotEmpty, IsOptional, IsString } from "class-validator";

import { LegacyLoginDto } from "./legacy-login.dto";

export class LegacyRegisterDto extends LegacyLoginDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  phone?: string;
}
