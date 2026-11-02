import { IsUUID } from "class-validator";

export class DocumentMutationDto {
  @IsUUID()
  clientId!: string;
}
