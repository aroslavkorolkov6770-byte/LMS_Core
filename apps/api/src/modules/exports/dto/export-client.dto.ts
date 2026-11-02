import { IsUUID } from "class-validator";

export class ExportClientDto {
  @IsUUID()
  clientId!: string;
}
