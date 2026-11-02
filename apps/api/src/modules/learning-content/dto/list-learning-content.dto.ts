import { IsUUID } from "class-validator";

export class ListLearningContentDto {
  @IsUUID()
  clientId!: string;
}
