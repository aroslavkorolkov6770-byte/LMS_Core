import { Allow, ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Length, Max, Min } from "class-validator";

export class RuntimeReadDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(128) @IsString({ each: true })
  keys!: string[];
}
export class RuntimeWriteDto {
  @IsString() key!: string;
  @Allow() data!: unknown;
  @IsInt() @Min(0) @Max(2147483646) expectedRevision!: number;
}
export class RuntimeBootstrapDto {
  @IsString() clientAdminLogin!: string;
  @IsString() @Length(12, 128) clientAdminPassword!: string;
  @IsString() @Length(1, 150) clientAdminName!: string;
  @IsString() systemAdminLogin!: string;
  @IsString() @Length(12, 128) systemAdminPassword!: string;
}
