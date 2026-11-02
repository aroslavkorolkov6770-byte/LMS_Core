import { IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min, MaxLength } from "class-validator";
import { IsInt } from "class-validator";

export class UpdateDeployProfileDto {
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  brandName?: string;

  @IsOptional()
  @IsString()
  clientAdminLogin?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  clientAdminName?: string;

  @IsOptional()
  @IsString()
  clientAdminPassword?: string;

  @IsOptional()
  @IsString()
  systemAdminLogin?: string;

  @IsOptional()
  @IsString()
  systemAdminPassword?: string;

  @IsOptional()
  @IsString()
  primaryColor?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  tariff?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  industryTemplate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  includedUsers?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxAdmins?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  aiRequestsLimit?: number;

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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  status?: string;
}
