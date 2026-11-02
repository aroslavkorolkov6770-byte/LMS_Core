CREATE TABLE IF NOT EXISTS "client_preview_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"theme" jsonb NOT NULL,
	"typography" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"layout" jsonb NOT NULL,
	"components" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_preview_settings_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_preview_settings" ADD CONSTRAINT "client_preview_settings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_preview_settings" ADD CONSTRAINT "client_preview_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
