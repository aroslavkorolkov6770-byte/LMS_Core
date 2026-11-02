import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { courses } from "./courses";
import { tests } from "./tests";
import { users } from "./users";

export const deadlines = pgTable("deadlines", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
  testId: uuid("test_id").references(() => tests.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  status: text("status").notNull().default("active"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
