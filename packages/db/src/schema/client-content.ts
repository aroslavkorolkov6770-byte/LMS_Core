import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { users } from "./users";

export const clientContent = pgTable(
  "client_content",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    payload: jsonb("payload").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    clientContentClientKeyUnique: unique("client_content_client_key_unique").on(
      table.clientId,
      table.key
    )
  })
);
