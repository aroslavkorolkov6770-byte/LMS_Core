import { Allow, IsUUID } from "class-validator";

export class PreviewSettingsQueryDto {
  @IsUUID()
  clientId!: string;
}

export class SavePreviewSettingsDto extends PreviewSettingsQueryDto {
  @Allow()
  theme?: unknown;

  @Allow()
  typography?: unknown;

  @Allow()
  content?: unknown;

  @Allow()
  layout?: unknown;

  @Allow()
  components?: unknown;

  @Allow()
  elementOverrides?: unknown;
}
