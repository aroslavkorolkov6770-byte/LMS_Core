import { IsBoolean, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateDocumentDto {
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  slug!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  storagePath?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}
