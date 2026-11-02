CREATE TABLE IF NOT EXISTS "user_profile_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE cascade,
	"user_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_profile_data_client_user_key_unique"
	ON "user_profile_data" ("client_id", "user_key");
