import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { clients } from "./clients";

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userKey: text("user_key").notNull(),
    endpoint: text("endpoint").notNull(),
    subscription: jsonb("subscription").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pushSubscriptionsClientEndpointUnique: unique(
      "push_subscriptions_client_endpoint_unique"
    ).on(table.clientId, table.endpoint)
  })
);
