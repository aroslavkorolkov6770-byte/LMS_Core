ALTER TABLE "courses"
ADD COLUMN IF NOT EXISTS "content_kind" text DEFAULT 'lesson' NOT NULL;
--> statement-breakpoint
ALTER TABLE "courses"
ADD COLUMN IF NOT EXISTS "content" jsonb;
--> statement-breakpoint
ALTER TABLE "courses"
ADD COLUMN IF NOT EXISTS "estimated_minutes" integer;
--> statement-breakpoint
ALTER TABLE "tests"
ADD COLUMN IF NOT EXISTS "content_kind" text DEFAULT 'quiz' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tests"
ADD COLUMN IF NOT EXISTS "content" jsonb;
--> statement-breakpoint
ALTER TABLE "tests"
ADD COLUMN IF NOT EXISTS "order_index" integer DEFAULT 0 NOT NULL;
