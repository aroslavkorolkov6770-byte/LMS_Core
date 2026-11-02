import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";

import { RoleCode } from "@lms-core/shared";

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  roleCode!: RoleCode;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
