import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { users } from "./users";

export const clientPreviewSettings = pgTable("client_preview_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .unique()
    .references(() => clients.id, { onDelete: "cascade" }),
  theme: jsonb("theme").notNull(),
  typography: jsonb("typography").notNull(),
  content: jsonb("content").notNull(),
  layout: jsonb("layout").notNull(),
  components: jsonb("components").notNull(),
  elementOverrides: jsonb("element_overrides").notNull().default({}),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
