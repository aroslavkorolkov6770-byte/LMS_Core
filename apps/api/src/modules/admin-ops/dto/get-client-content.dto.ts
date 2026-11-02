import { IsNotEmpty, IsString, IsUUID } from "class-validator";

export class GetClientContentDto {
  @IsUUID()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  key!: string;
}
