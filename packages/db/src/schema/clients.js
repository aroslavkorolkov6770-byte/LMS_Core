"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clients = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
exports.clients = (0, pg_core_1.pgTable)("clients", {
    id: (0, pg_core_1.uuid)("id").defaultRandom().primaryKey(),
    name: (0, pg_core_1.text)("name").notNull(),
    slug: (0, pg_core_1.text)("slug").notNull().unique(),
    domain: (0, pg_core_1.text)("domain").notNull().unique(),
    brandName: (0, pg_core_1.text)("brand_name").notNull(),
    primaryColor: (0, pg_core_1.text)("primary_color"),
    tariff: (0, pg_core_1.text)("tariff").notNull(),
    isActive: (0, pg_core_1.boolean)("is_active").notNull().default(true),
    includedUsers: (0, pg_core_1.integer)("included_users").notNull().default(5),
    maxAdmins: (0, pg_core_1.integer)("max_admins").notNull().default(1),
    aiRequestsLimit: (0, pg_core_1.integer)("ai_requests_limit"),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true }).notNull().defaultNow()
});
