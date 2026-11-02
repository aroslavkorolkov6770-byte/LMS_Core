import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";

export const deployProfiles = pgTable("deploy_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .unique()
    .references(() => clients.id, { onDelete: "cascade" }),
  hostUrl: text("host_url").notNull(),
  deployPath: text("deploy_path"),
  lmsSourcePath: text("lms_source_path"),
  deploymentBundlePath: text("deployment_bundle_path"),
  databaseHost: text("database_host").notNull(),
  databasePort: integer("database_port").notNull().default(5432),
  databaseName: text("database_name").notNull(),
  databaseUser: text("database_user").notNull(),
  databasePasswordSecretRef: text("database_password_secret_ref"),
  storageBucket: text("storage_bucket").notNull(),
  storageRegion: text("storage_region"),
  storageEndpoint: text("storage_endpoint"),
  storageSecretRef: text("storage_secret_ref"),
  aiProvider: text("ai_provider").notNull(),
  aiModel: text("ai_model").notNull(),
  aiSecretRef: text("ai_secret_ref"),
  aliceTenantCode: text("alice_tenant_code"),
  aliceModelPreset: text("alice_model_preset"),
  previewThemePrimary: text("preview_theme_primary"),
  previewThemeAccent: text("preview_theme_accent"),
  previewThemeBackground: text("preview_theme_background"),
  previewThemeSurface: text("preview_theme_surface"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
