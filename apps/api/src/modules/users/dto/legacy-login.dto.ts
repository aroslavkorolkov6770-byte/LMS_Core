import { IsNotEmpty, IsString, IsUUID } from "class-validator";

export class LegacyLoginDto {
  @IsUUID()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  login!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
