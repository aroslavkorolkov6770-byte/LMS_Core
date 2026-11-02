import { IsUUID } from "class-validator";

export class ValidateClientDto {
  @IsUUID()
  clientId!: string;
}
