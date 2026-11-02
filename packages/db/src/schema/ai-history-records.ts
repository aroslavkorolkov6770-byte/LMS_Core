import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { users } from "./users";

export const aiHistoryRecords = pgTable(
  "ai_history_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userKey: text("user_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    encryptionVersion: integer("encryption_version").notNull().default(1),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    aiHistoryRecordsClientUserKeyUnique: unique(
      "ai_history_records_client_user_key_unique"
    ).on(table.clientId, table.userKey)
  })
);
