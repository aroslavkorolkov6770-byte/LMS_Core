import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { clients } from "./clients";

// A compatibility boundary for the selected LMS, not a replacement for normalized Core modules.
export const lmsRuntimeValues = pgTable("lms_runtime_values", {
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  key: text("storage_key").notNull(),
  revision: integer("revision").notNull(),
  encrypted: jsonb("encrypted_payload"),
  deleted: boolean("is_deleted").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  pk: primaryKey({ columns: [table.clientId, table.key] }),
  revisionRange: check("lms_runtime_values_revision_check", sql`${table.revision} >= 0`),
  keyLength: check("lms_runtime_values_key_check", sql`char_length(${table.key}) BETWEEN 1 AND 200`),
  payloadRequired: check("lms_runtime_values_payload_check", sql`${table.deleted} OR ${table.encrypted} IS NOT NULL`)
}));

export const lmsRuntimeHistory = pgTable("lms_runtime_value_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  key: text("storage_key").notNull(),
  revision: integer("revision").notNull(),
  encrypted: jsonb("encrypted_payload"),
  deleted: boolean("is_deleted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  version: uniqueIndex("lms_runtime_history_version_unique").on(table.clientId, table.key, table.revision),
  revisionRange: check("lms_runtime_history_revision_check", sql`${table.revision} > 0`),
  keyLength: check("lms_runtime_history_key_check", sql`char_length(${table.key}) BETWEEN 1 AND 200`),
  payloadRequired: check("lms_runtime_history_payload_check", sql`${table.deleted} OR ${table.encrypted} IS NOT NULL`)
}));
