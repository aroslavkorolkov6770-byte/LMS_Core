import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";
import { roles } from "./roles";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id, { onDelete: "restrict" }),
  email: text("email").notNull(),
  phone: text("phone"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  passwordHash: text("password_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
