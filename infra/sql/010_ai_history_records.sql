CREATE TABLE IF NOT EXISTS "ai_history_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE cascade,
	"user_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"encryption_version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_history_records_client_user_key_unique"
	ON "ai_history_records" ("client_id", "user_key");
