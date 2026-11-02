import { IsArray, IsString, IsUUID } from "class-validator";

export class LegacySyncProgressDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  userId!: string;

  @IsArray()
  @IsString({ each: true })
  completedRouteSlugs!: string[];
}
