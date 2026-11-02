import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import postgres, { Sql } from "postgres";
import { userInfo } from "node:os";

const protocol = "lms-core-db-v1";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Query = Pick<Sql, "unsafe">;
export class DatabaseProvisionError extends Error {
  public requiresAttention = false;
  constructor(public readonly code: string) { super(code); }
}
const requireCondition = (condition: unknown, code: string): void => {
  if (!condition) throw new DatabaseProvisionError(code);
};

export function clientDatabaseNames(clientId: string) {
  requireCondition(typeof clientId === "string" && uuid.test(clientId), "INVALID_DATABASE_CLIENT");
  const suffix = clientId.replaceAll("-", "");
  return { database: `lms_${suffix}`, role: `lms_role_${suffix}` };
}

function connectionUrl(value: string): URL {
  try {
    const url = new URL(value);
    requireCondition(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && url.username &&
      url.pathname.length > 1 && !url.hash, "INVALID_DATABASE_CONFIG");
    requireCondition([...url.searchParams.keys()].every((key) => key === "sslmode") && url.searchParams.getAll("sslmode").length <= 1 &&
      (!url.searchParams.has("sslmode") || ["disable", "require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode")!)), "INVALID_DATABASE_CONFIG");
    return url;
  } catch { throw new DatabaseProvisionError("INVALID_DATABASE_CONFIG"); }
}

export function clientDatabaseUrl(maintenanceUrl: string, clientId: string, password: string): string {
  validateServicePassword(password);
  const url = connectionUrl(maintenanceUrl);
  const names = clientDatabaseNames(clientId);
  // Preserve transport/TLS options; only the database identity changes.
  url.pathname = `/${names.database}`;
  url.username = names.role;
  url.password = password;
  return url.href;
}

function validateServicePassword(password: string) {
  // Core must generate and privately retain this value before provisioning starts.
  requireCondition(typeof password === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(password), "INVALID_DATABASE_SERVICE_PASSWORD");
}

function scramVerifier(password: string, salt: Buffer, iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  salted.fill(0); clientKey.fill(0);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

function passwordMatches(password: string, verifier: unknown): boolean {
  if (typeof verifier !== "string") return false;
  const match = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/.exec(verifier);
  if (!match) return false;
  const expected = Buffer.from(scramVerifier(password, Buffer.from(match[1], "base64")));
  const actual = Buffer.from(verifier);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function roleState(sql: Query, role: string) {
  const [value] = await sql.unsafe(`SELECT r.oid, r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
    r.rolcanlogin, r.rolreplication, r.rolbypassrls, r.rolvaliduntil, r.rolconfig,
    shobj_description(r.oid,'pg_authid') AS marker,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships
    FROM pg_roles r WHERE r.rolname=$1`, [role]);
  return value;
}

function roleIsRestricted(role: Record<string, unknown> | undefined): boolean {
  return !!role && role.rolcanlogin === true && role.rolsuper === false && role.rolcreatedb === false &&
    role.rolcreaterole === false && role.rolinherit === false && role.rolreplication === false &&
    role.rolbypassrls === false && role.memberships === false && role.rolvaliduntil === null && role.rolconfig === null;
}

async function sessionTransaction(sql: Query, work: () => Promise<void>) {
  // postgres.js reserved sessions do not expose begin() at runtime despite the inherited type.
  // Keep the transaction on this exact session so the advisory lock remains effective.
  await sql.unsafe("BEGIN");
  try { await work(); await sql.unsafe("COMMIT"); }
  catch (error) {
    try { await sql.unsafe("ROLLBACK"); } catch { /* The dedicated pool is closed by the caller. */ }
    throw error;
  }
}

async function databaseState(sql: Query, database: string) {
  const [value] = await sql.unsafe(`SELECT d.oid, d.datname, pg_get_userbyid(d.datdba) AS owner,
    d.datistemplate, d.datallowconn, shobj_description(d.oid,'pg_database') AS marker,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=0) AS public_access
    FROM pg_database d WHERE d.datname=$1`, [database]);
  return value;
}

async function assertRestrictedConnection(sql: Query, clientId: string) {
  const names = clientDatabaseNames(clientId);
  const [identity] = await sql.unsafe("SELECT current_user AS role, session_user AS session, current_database() AS database");
  requireCondition(identity.role === names.role && identity.session === names.role && identity.database === names.database, "DATABASE_ROLE_NOT_RESTRICTED");
  const role = await roleState(sql, names.role);
  const database = await databaseState(sql, names.database);
  requireCondition(roleIsRestricted(role), "DATABASE_ROLE_NOT_RESTRICTED");
  const prefix = `${protocol}:${clientId}:`;
  const marker = typeof role.marker === "string" ? role.marker : "";
  requireCondition(marker.startsWith(prefix) && uuid.test(marker.slice(prefix.length)) && database?.marker === `${marker}:ready` &&
    database.owner === names.role && database.datistemplate === false && database.datallowconn === true && database.public_access === false, "DATABASE_OWNERSHIP_MISMATCH");
  const [schema] = await sql.unsafe(`SELECT EXISTS(SELECT 1 FROM pg_namespace n,
    LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0) AS public_access`);
  requireCondition(schema.public_access === false, "DATABASE_OWNERSHIP_MISMATCH");
  return { restricted: true, clientId, ...names };
}

export async function assertRestrictedDatabaseRole(databaseUrl: string, clientId: string) {
  connectionUrl(databaseUrl);
  clientDatabaseNames(clientId);
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {}, connection: { statement_timeout: 15000 } });
  try { return await assertRestrictedConnection(sql, clientId); }
  catch (error) {
    if (error instanceof DatabaseProvisionError) throw error;
    throw new DatabaseProvisionError("DATABASE_ROLE_CHECK_FAILED");
  } finally { await sql.end({ timeout: 5 }); }
}

type ProvisionInput = { clientId: string; jobId: string; password: string };
export async function provisionClientDatabase(maintenanceUrl: string, input: ProvisionInput) {
  return provisionDatabase(maintenanceUrl, input, false);
}
export async function provisionLocalClientDatabase(input: ProvisionInput) {
  requireCondition(process.platform === "linux" && userInfo().username === "postgres", "DATABASE_LOCAL_PEER_REQUIRED");
  return provisionDatabase("postgresql://postgres@127.0.0.1:5432/postgres", input, true);
}
async function provisionDatabase(maintenanceUrl: string, input: ProvisionInput, localPeer: boolean) {
  requireCondition(input && typeof input === "object" && Object.keys(input).every((key) => ["clientId", "jobId", "password"].includes(key)), "INVALID_DATABASE_PROVISION_INPUT");
  const names = clientDatabaseNames(input.clientId);
  requireCondition(typeof input.jobId === "string" && uuid.test(input.jobId), "INVALID_DATABASE_JOB");
  validateServicePassword(input.password);
  const url = connectionUrl(maintenanceUrl);
  requireCondition(url.pathname === "/postgres", "DATABASE_MAINTENANCE_REQUIRED");
  const marker = `${protocol}:${input.clientId}:${input.jobId}`;
  const admin = postgres(url.href, { ...(localPeer ? { host: "/var/run/postgresql" } : {}), max: 1, connect_timeout: 10, onnotice: () => {}, connection: { statement_timeout: 30000, lock_timeout: 10000 } });
  let session: Awaited<ReturnType<typeof admin.reserve>> | undefined;
  let locked = false;
  let changed = false;
  try {
    session = await admin.reserve();
    const [authority] = await session.unsafe("SELECT rolsuper FROM pg_roles WHERE rolname=current_user");
    requireCondition(authority.rolsuper === true, "DATABASE_PROVISION_ADMIN_REQUIRED");
    const [lock] = await session.unsafe("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [`${protocol}:${input.clientId}`]);
    requireCondition(lock.acquired === true, "DATABASE_PROVISION_BUSY"); locked = true;
    let role = await roleState(session, names.role);
    const database = await databaseState(session, names.database);
    // An occupied or unmarked object is never adopted, deleted or assigned a new password.
    requireCondition(!database || (role && role.marker === marker && database.owner === names.role &&
      database.datistemplate === false && database.datallowconn === true &&
      [marker + ":pending", marker + ":ready"].includes(database.marker)), "DATABASE_PROVISION_CONFLICT");
    if (role) {
      requireCondition(role.marker === marker && roleIsRestricted(role), "DATABASE_PROVISION_CONFLICT");
      changed = !database || database.marker === `${marker}:pending`;
      const [secret] = await session.unsafe("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [names.role]);
      requireCondition(passwordMatches(input.password, secret.rolpassword), "DATABASE_SERVICE_PASSWORD_MISMATCH");
    } else {
      // Only the verifier reaches PostgreSQL DDL/logging, never the clear service password.
      const verifier = scramVerifier(input.password, randomBytes(16));
      changed = true;
      await sessionTransaction(session, async () => {
        await session!.unsafe(`CREATE ROLE "${names.role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}'`);
        await session!.unsafe(`COMMENT ON ROLE "${names.role}" IS '${marker}'`);
      });
      role = await roleState(session, names.role);
    }
    const reused = database?.marker === `${marker}:ready`;
    if (!database) {
      // CREATE DATABASE cannot be transactional. An unmarked result requires inspection, not automatic cleanup.
      changed = true;
      await session.unsafe(`CREATE DATABASE "${names.database}" OWNER "${names.role}" TEMPLATE template0 ALLOW_CONNECTIONS false`);
      await sessionTransaction(session, async () => {
        await session!.unsafe(`REVOKE ALL ON DATABASE "${names.database}" FROM PUBLIC`);
        await session!.unsafe(`COMMENT ON DATABASE "${names.database}" IS '${marker}:pending'`);
        await session!.unsafe(`ALTER DATABASE "${names.database}" ALLOW_CONNECTIONS true`);
      });
    }
    const tenantUrl = clientDatabaseUrl(url.href, input.clientId, input.password);
    if (!reused) {
      const tenant = postgres(tenantUrl, { max: 1, connect_timeout: 10, onnotice: () => {}, connection: { statement_timeout: 15000 } });
      try {
        const [contents] = await tenant.unsafe(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AS occupied`);
        requireCondition(contents.occupied === false, "DATABASE_PROVISION_CONFLICT");
        await tenant.unsafe("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      } finally { await tenant.end({ timeout: 5 }); }
      await session.unsafe(`COMMENT ON DATABASE "${names.database}" IS '${marker}:ready'`);
      changed = true;
    }
    await assertRestrictedDatabaseRole(tenantUrl, input.clientId);
    return { provisioned: true, reused, clientId: input.clientId, jobId: input.jobId, ...names };
  } catch (error) {
    const failure = error instanceof DatabaseProvisionError ? error : new DatabaseProvisionError(changed ? "DATABASE_PROVISION_NEEDS_ATTENTION" : "DATABASE_PROVISION_FAILED");
    failure.requiresAttention ||= changed;
    throw failure;
  } finally {
    if (session) {
      // Ending the dedicated pool also releases the session lock if an unlock query fails.
      try { if (locked) await session.unsafe("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`${protocol}:${input.clientId}`]); }
      catch { /* Preserve the original sanitized result; pool shutdown releases the lock. */ }
      session.release();
    }
    await admin.end({ timeout: 5 });
  }
}
