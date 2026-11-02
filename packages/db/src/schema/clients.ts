import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const clients = pgTable("clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  domain: text("domain").notNull().unique(),
  brandName: text("brand_name").notNull(),
  primaryColor: text("primary_color"),
  tariff: text("tariff").notNull(),
  industryTemplate: text("industry_template").notNull().default("coffee_shop"),
  isActive: boolean("is_active").notNull().default(true),
  includedUsers: integer("included_users").notNull().default(5),
  maxAdmins: integer("max_admins").notNull().default(1),
  aiRequestsLimit: integer("ai_requests_limit"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
