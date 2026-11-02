import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { documents } from "./documents";
import { users } from "./users";

export const acknowledgements = pgTable(
  "acknowledgements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    comment: text("comment"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    acknowledgementsUserDocumentUnique: unique("acknowledgements_user_document_unique").on(
      table.userId,
      table.documentId
    )
  })
);
