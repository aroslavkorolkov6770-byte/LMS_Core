ALTER TABLE "client_preview_settings"
ADD COLUMN IF NOT EXISTS "element_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;
