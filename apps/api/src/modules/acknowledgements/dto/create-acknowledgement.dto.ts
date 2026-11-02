import { IsOptional, IsString, IsUUID } from "class-validator";

export class CreateAcknowledgementDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  userId!: string;

  @IsUUID()
  documentId!: string;

  @IsOptional()
  @IsString()
  comment?: string;
}
