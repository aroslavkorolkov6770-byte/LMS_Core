import { IsUUID } from "class-validator";

export class DeployClientDetailDto {
  @IsUUID()
  clientId!: string;
}
