import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq } from "drizzle-orm";
import { schema } from "@lms-core/db";
import { DatabaseService } from "../database/database.service";
import { createRuntimeAccounts, RUNTIME_PROTOCOL, RUNTIME_USERS_KEY, runtimeKey, serializeRuntimePayload, validateRuntimeUsers } from "./runtime-contract";
import { RuntimeCryptoService } from "./runtime-crypto.service";
import { RuntimeBootstrapDto, RuntimeWriteDto } from "./runtime.dto";

type Transaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
type ValueRow = typeof schema.lmsRuntimeValues.$inferSelect;

@Injectable()
export class RuntimeService {
  constructor(private readonly database: DatabaseService, private readonly crypto: RuntimeCryptoService, private readonly config: ConfigService) {}
  private result(row: ValueRow | undefined, clientId: string, key: string) {
    return { key, found: Boolean(row && !row.deleted), revision: row?.revision ?? 0,
      data: row && !row.deleted ? this.crypto.decrypt(row.encrypted, clientId, key, row.revision) : null };
  }
  async read(clientId: string, keys: string[]) {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 128) throw new BadRequestException("Invalid runtime keys");
    const unique = [...new Set(keys.map(runtimeKey))];
    try {
      const entries = new Map<string, ReturnType<RuntimeService["result"]>>();
      const sizes = new Map<string, number>();
      let total = 0;
      for (const key of unique) {
        const [row] = await this.database.db.select().from(schema.lmsRuntimeValues)
          .where(and(eq(schema.lmsRuntimeValues.clientId, clientId), eq(schema.lmsRuntimeValues.key, key))).limit(1);
        if (key === RUNTIME_USERS_KEY && (!row || row.deleted)) throw new ConflictException("Runtime administrators have not been initialized");
        const size = row?.encrypted && typeof row.encrypted === "object" && "ciphertext" in row.encrypted && typeof row.encrypted.ciphertext === "string" ? Math.ceil(row.encrypted.ciphertext.length * 0.75) + 1024 : 1024;
        total += size;
        if (total > 32 * 1024 * 1024) throw new BadRequestException("Runtime batch is too large");
        sizes.set(key, size);
        entries.set(key, this.result(row, clientId, key));
      }
      total = 0;
      const requested = [...new Set(keys)].map((requestedKey) => {
        const key = runtimeKey(requestedKey);
        total += sizes.get(key) || 0;
        if (total > 32 * 1024 * 1024) throw new BadRequestException("Runtime batch is too large");
        return { ...entries.get(key)!, requestedKey };
      });
      return { protocol: RUNTIME_PROTOCOL, entries: requested };
    } catch (error) { this.failure(error); }
  }
  private async locked(tx: Transaction, clientId: string, key: string) {
    // The placeholder participates in the transaction, serializing even the very first write.
    await tx.insert(schema.lmsRuntimeValues).values({ clientId, key, revision: 0, encrypted: null, deleted: true }).onConflictDoNothing();
    const [row] = await tx.select().from(schema.lmsRuntimeValues)
      .where(and(eq(schema.lmsRuntimeValues.clientId, clientId), eq(schema.lmsRuntimeValues.key, key))).for("update");
    if (!row) throw new ServiceUnavailableException("Runtime value could not be locked");
    return row;
  }
  private async writeLocked(tx: Transaction, clientId: string, row: ValueRow, data: unknown, serialized: string) {
    if (row.revision > 0) await tx.insert(schema.lmsRuntimeHistory).values({ clientId, key: row.key, revision: row.revision, encrypted: row.encrypted, deleted: row.deleted });
    const revision = row.revision + 1;
    const deleted = data === null;
    await tx.update(schema.lmsRuntimeValues).set({ revision, deleted, encrypted: deleted ? null : this.crypto.encrypt(serialized, clientId, row.key, revision), updatedAt: new Date() })
      .where(and(eq(schema.lmsRuntimeValues.clientId, clientId), eq(schema.lmsRuntimeValues.key, row.key)));
    await tx.insert(schema.auditLog).values({ clientId, actorUserId: null, action: deleted ? "runtime.value.deleted" : "runtime.value.saved", entityType: "lms_runtime_value", entityId: row.key,
      details: { revision, previousRevision: row.revision } });
    return revision;
  }
  async write(clientId: string, input: RuntimeWriteDto) {
    const key = runtimeKey(input.key);
    const serialized = serializeRuntimePayload(input.data);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 2147483646) throw new BadRequestException("Expected revision is required");
    if (key === RUNTIME_USERS_KEY) validateRuntimeUsers(input.data);
    try {
      const revision = await this.database.db.transaction(async (tx) => {
        const row = await this.locked(tx, clientId, key);
        if (row.revision !== input.expectedRevision) throw new ConflictException("Runtime value changed; reload before saving");
        if (key === RUNTIME_USERS_KEY && row.revision === 0) throw new ConflictException("Initialize administrators through the one-time bootstrap first");
        return this.writeLocked(tx, clientId, row, input.data, serialized);
      });
      return { protocol: RUNTIME_PROTOCOL, key, revision, deleted: input.data === null };
    } catch (error) { this.failure(error); }
  }
  async bootstrap(clientId: string, input: RuntimeBootstrapDto) {
    if (this.config.get<boolean>("runtime.bootstrapEnabled", false) !== true) throw new ForbiddenException("Runtime bootstrap is disabled");
    let userIds: string[] = [];
    try {
      await this.database.db.transaction(async (tx) => {
        const row = await this.locked(tx, clientId, RUNTIME_USERS_KEY);
        if (row.revision !== 0) throw new ConflictException("Runtime has already been initialized; credentials were not replaced");
        const accounts = createRuntimeAccounts(input);
        userIds = accounts.map((account) => account.id);
        await this.writeLocked(tx, clientId, row, accounts, serializeRuntimePayload(accounts));
        await tx.insert(schema.auditLog).values({ clientId, actorUserId: null, action: "runtime.administrators.initialized", entityType: "lms_runtime_bootstrap", entityId: clientId,
          details: { accountCount: accounts.length, userIds: accounts.map((account) => account.id) } });
      });
      return { protocol: RUNTIME_PROTOCOL, initialized: true, userIds };
    } catch (error) { this.failure(error); }
  }
  private failure(error: unknown): never {
    if (error instanceof HttpException) throw error;
    // Driver exceptions can include SQL arguments and secrets. Never return/log them here.
    throw new ServiceUnavailableException("Runtime PostgreSQL operation failed");
  }
}
