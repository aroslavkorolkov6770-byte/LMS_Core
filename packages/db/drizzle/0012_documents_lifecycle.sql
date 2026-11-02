ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
UPDATE "documents"
SET "source" = 'lms_legacy'
WHERE "storage_path" LIKE 'file_data_%';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_client_slug_unique"
	ON "documents" ("client_id", "slug");
