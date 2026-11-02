import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { users } from "./users";

export const userDismissedTasks = pgTable(
  "user_dismissed_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userKey: text("user_key").notNull(),
    taskKeys: text("task_keys").array().notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    userDismissedTasksClientUserKeyUnique: unique(
      "user_dismissed_tasks_client_user_key_unique"
    ).on(table.clientId, table.userKey)
  })
);
