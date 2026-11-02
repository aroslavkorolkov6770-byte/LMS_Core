import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";

export class BootstrapClientDto {
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

  @IsString()
  @IsNotEmpty()
  adminEmail!: string;

  @IsOptional()
  @IsString()
  adminLogin?: string;

  @IsOptional()
  @IsString()
  adminPhone?: string;

  @IsString()
  @IsNotEmpty()
  adminFirstName!: string;

  @IsOptional()
  @IsString()
  adminLastName?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  adminPassword!: string;

  @IsString()
  @IsNotEmpty()
  systemAdminLogin!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  systemAdminPassword!: string;

  @IsString()
  @IsNotEmpty()
  hostUrl!: string;

  @IsOptional()
  @IsString()
  deployPath?: string;

  @IsOptional()
  @IsString()
  lmsSourcePath?: string;

  @IsString()
  @IsNotEmpty()
  databaseHost!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  databasePort!: number;

  @IsString()
  @IsNotEmpty()
  databaseName!: string;

  @IsString()
  @IsNotEmpty()
  databaseUser!: string;

  @IsOptional()
  @IsString()
  databasePasswordSecretRef?: string;

  @IsString()
  @IsNotEmpty()
  storageBucket!: string;

  @IsOptional()
  @IsString()
  storageRegion?: string;

  @IsOptional()
  @IsString()
  storageEndpoint?: string;

  @IsOptional()
  @IsString()
  storageSecretRef?: string;

  @IsString()
  @IsNotEmpty()
  aiProvider!: string;

  @IsString()
  @IsNotEmpty()
  aiModel!: string;

  @IsOptional()
  @IsString()
  aiSecretRef?: string;

  @IsOptional()
  @IsString()
  aliceTenantCode?: string;

  @IsOptional()
  @IsString()
  aliceModelPreset?: string;

  @IsOptional()
  @IsString()
  previewThemePrimary?: string;

  @IsOptional()
  @IsString()
  previewThemeAccent?: string;

  @IsOptional()
  @IsString()
  previewThemeBackground?: string;

  @IsOptional()
  @IsString()
  previewThemeSurface?: string;
}
