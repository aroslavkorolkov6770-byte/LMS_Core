CREATE TABLE IF NOT EXISTS "lms_runtime_values" (
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "storage_key" text NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 0),
  "encrypted_payload" jsonb,
  "is_deleted" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("client_id", "storage_key"),
  CHECK (char_length("storage_key") BETWEEN 1 AND 200),
  CHECK ("is_deleted" OR "encrypted_payload" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lms_runtime_value_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "storage_key" text NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "encrypted_payload" jsonb,
  "is_deleted" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("client_id", "storage_key", "revision"),
  CHECK ("is_deleted" OR "encrypted_payload" IS NOT NULL)
);
