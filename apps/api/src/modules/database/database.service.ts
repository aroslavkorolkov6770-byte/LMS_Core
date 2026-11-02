import { Inject, Injectable } from "@nestjs/common";

import { DbClient } from "@lms-core/db";

import { DB_CLIENT } from "./database.constants";

@Injectable()
export class DatabaseService {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  get db(): DbClient {
    return this.dbClient;
  }
}
