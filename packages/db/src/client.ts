import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export function createDbClient(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 1
  });

  return drizzle(sql, {
    schema
  });
}

export type DbClient = ReturnType<typeof createDbClient>;

export function createDbConnection(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 1
  });

  const db = drizzle(sql, {
    schema
  });

  return {
    db,
    sql
  };
}
