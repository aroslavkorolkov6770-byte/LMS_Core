import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

export class CreateClientDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  slug!: string;

  @IsString()
  @IsNotEmpty()
  domain!: string;

  @IsString()
  @IsNotEmpty()
  brandName!: string;

  @IsOptional()
  @IsString()
  primaryColor?: string;

  @IsString()
  @IsNotEmpty()
  tariff!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  industryTemplate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  includedUsers?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAdmins?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  aiRequestsLimit?: number;
}
