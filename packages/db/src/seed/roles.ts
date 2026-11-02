import { CORE_ROLES } from "@lms-core/shared";
import { eq } from "drizzle-orm";

import { createDbConnection } from "../client";
import { roles } from "../schema";

async function seedRoles(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed roles");
  }

  const { db, sql } = createDbConnection(databaseUrl);

  try {
    for (const role of CORE_ROLES) {
      const existingRoles = await db.select().from(roles).where(eq(roles.code, role.code)).limit(1);

      if (existingRoles.length === 0) {
        await db.insert(roles).values(role);
      }
    }
  } finally {
    await sql.end();
  }
}

void seedRoles();
