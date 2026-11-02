"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deployProfiles = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const clients_1 = require("./clients");
exports.deployProfiles = (0, pg_core_1.pgTable)("deploy_profiles", {
    id: (0, pg_core_1.uuid)("id").defaultRandom().primaryKey(),
    clientId: (0, pg_core_1.uuid)("client_id")
        .notNull()
        .unique()
        .references(() => clients_1.clients.id, { onDelete: "cascade" }),
    hostUrl: (0, pg_core_1.text)("host_url").notNull(),
    deployPath: (0, pg_core_1.text)("deploy_path"),
    databaseHost: (0, pg_core_1.text)("database_host").notNull(),
    databasePort: (0, pg_core_1.integer)("database_port").notNull().default(5432),
    databaseName: (0, pg_core_1.text)("database_name").notNull(),
    databaseUser: (0, pg_core_1.text)("database_user").notNull(),
    databasePasswordSecretRef: (0, pg_core_1.text)("database_password_secret_ref"),
    storageBucket: (0, pg_core_1.text)("storage_bucket").notNull(),
    storageRegion: (0, pg_core_1.text)("storage_region"),
    storageEndpoint: (0, pg_core_1.text)("storage_endpoint"),
    storageSecretRef: (0, pg_core_1.text)("storage_secret_ref"),
    aiProvider: (0, pg_core_1.text)("ai_provider").notNull(),
    aiModel: (0, pg_core_1.text)("ai_model").notNull(),
    aiSecretRef: (0, pg_core_1.text)("ai_secret_ref"),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true }).notNull().defaultNow()
});
