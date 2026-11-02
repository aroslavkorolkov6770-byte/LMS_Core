import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDbClient } from "@lms-core/db";

import { DB_CLIENT } from "./database.constants";
import { DatabaseService } from "./database.service";

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.get<string>("database.url");

        if (!databaseUrl) {
          throw new Error("DATABASE_URL is required to create the database client");
        }

        return createDbClient(databaseUrl);
      }
    },
    DatabaseService
  ],
  exports: [DB_CLIENT, DatabaseService]
})
export class DatabaseModule {}
