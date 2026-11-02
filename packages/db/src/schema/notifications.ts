import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { deadlines } from "./deadlines";
import { documents } from "./documents";
import { users } from "./users";

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deadlineId: uuid("deadline_id").references(() => deadlines.id, { onDelete: "set null" }),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  legacyId: text("legacy_id"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  channel: text("channel").notNull().default("in_app"),
  status: text("status").notNull().default("unread"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
