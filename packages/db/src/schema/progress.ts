import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { courses } from "./courses";
import { tests } from "./tests";
import { users } from "./users";

export const progress = pgTable(
  "progress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    lastTestId: uuid("last_test_id").references(() => tests.id, { onDelete: "set null" }),
    status: text("status").notNull().default("not_started"),
    completionPercent: integer("completion_percent").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    progressUserCourseUnique: unique("progress_user_course_unique").on(
      table.userId,
      table.courseId
    )
  })
);
