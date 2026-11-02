import { IsUUID } from "class-validator";

export class DeployWorkflowActionDto {
  @IsUUID()
  clientId!: string;
}
