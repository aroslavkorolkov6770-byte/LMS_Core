import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { tests } from "./tests";
import { users } from "./users";

export const testAttempts = pgTable("test_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  testId: uuid("test_id").references(() => tests.id, { onDelete: "set null" }),
  legacyAttemptId: text("legacy_attempt_id"),
  legacyTestSlug: text("legacy_test_slug").notNull(),
  testTitle: text("test_title").notNull(),
  score: integer("score").notNull(),
  isPassed: boolean("is_passed").notNull().default(false),
  attemptNumber: integer("attempt_number").notNull().default(1),
  answers: jsonb("answers"),
  mistakes: jsonb("mistakes"),
  source: text("source").notNull().default("lms_legacy"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
