import { IsArray, IsString, IsUUID } from "class-validator";

export class LegacySyncPassedTestsDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  userId!: string;

  @IsArray()
  @IsString({ each: true })
  passedTestSlugs!: string[];
}
