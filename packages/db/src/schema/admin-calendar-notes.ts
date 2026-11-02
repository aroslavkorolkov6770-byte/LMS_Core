import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { users } from "./users";

export const adminCalendarNotes = pgTable(
  "admin_calendar_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    dateKey: text("date_key").notNull(),
    noteText: text("note_text").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    adminCalendarNotesClientDateKeyUnique: unique(
      "admin_calendar_notes_client_date_key_unique"
    ).on(table.clientId, table.dateKey)
  })
);
