CREATE TABLE IF NOT EXISTS "admin_calendar_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE cascade,
	"date_key" text NOT NULL,
	"note_text" text NOT NULL,
	"updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_calendar_notes_client_date_key_unique"
	ON "admin_calendar_notes" ("client_id", "date_key");
