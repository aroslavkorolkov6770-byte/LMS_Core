import { IsOptional, IsUUID } from "class-validator";

export class ClientFeaturesDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
