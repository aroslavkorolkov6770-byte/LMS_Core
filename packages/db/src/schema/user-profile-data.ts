import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { users } from "./users";

export const userProfileData = pgTable(
  "user_profile_data",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userKey: text("user_key").notNull(),
    payload: jsonb("payload").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    userProfileDataClientUserKeyUnique: unique(
      "user_profile_data_client_user_key_unique"
    ).on(table.clientId, table.userKey)
  })
);
