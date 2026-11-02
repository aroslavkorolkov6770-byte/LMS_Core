CREATE TABLE IF NOT EXISTS "user_dismissed_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE cascade,
	"user_key" text NOT NULL,
	"task_keys" text[] NOT NULL,
	"updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_dismissed_tasks_client_user_key_unique"
	ON "user_dismissed_tasks" ("client_id", "user_key");
