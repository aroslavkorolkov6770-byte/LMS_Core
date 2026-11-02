import { createHash } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres, { Sql } from "postgres";
import { CORE_ROLES, INDUSTRY_TEMPLATE_CODES, TARIFF_FEATURES, TariffCode } from "@lms-core/shared";
import * as schema from "./schema";

export const FRESH_SCHEMA_VERSION = "core-runtime-schema-v1";
type Connection = Pick<Sql, "unsafe">;
type Shape = { name: string; columns: Array<{ name: string; type: string; notNull: boolean; hasDefault: boolean }>;
  constraints: Array<{ name: string; type: string }>; indexes: string[] };
export type FreshClient = { id: string; name: string; slug: string; domain: string; brandName: string; tariff: string;
  industryTemplate: string; includedUsers: number; maxAdmins: number; aiRequestsLimit: number | null; primaryColor: string | null };
export type FreshBaseline = { version: string; sha256: string; schemaSha256: string; sql: string };
export class FreshInstallError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export const contentSha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ordered = <T extends { name: string }>(items: T[]) => items.sort((left, right) => left.name.localeCompare(right.name, "en"));

export function freshSchemaShape(): Shape[] {
  return ordered(Object.values(schema).map((table) => {
    const config = getTableConfig(table);
    const constraints = config.foreignKeys.map((fk) => ({ name: fk.getName(), type: "f" }))
      .concat(config.uniqueConstraints.map((key) => ({ name: key.name!, type: "u" })))
      .concat(config.columns.filter((column) => column.isUnique).map((column) => ({ name: column.uniqueName!, type: "u" })))
      .concat(config.primaryKeys.map((key) => ({ name: key.getName(), type: "p" })))
      .concat(config.columns.some((column) => column.primary) ? [{ name: `${config.name}_pkey`, type: "p" }] : [])
      .concat(config.checks.map((check) => ({ name: check.name, type: "c" })));
    return { name: config.name, columns: ordered(config.columns.map((column) => ({ name: column.name, type: column.getSQLType(), notNull: column.notNull, hasDefault: column.hasDefault }))),
      constraints: ordered(constraints), indexes: config.indexes.map((index) => {
        if (!index.config.name) throw new FreshInstallError("UNNAMED_SCHEMA_INDEX");
        return index.config.name;
      }).sort() };
  }));
}
export const freshSchemaSha256 = () => contentSha256(JSON.stringify(freshSchemaShape()));

export function normalizeFreshClient(input: unknown): FreshClient {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FreshInstallError("INVALID_CLIENT_CONFIG");
  const value = input as Record<string, unknown>;
  const allowed = new Set(["id", "name", "slug", "domain", "brandName", "tariff", "industryTemplate", "includedUsers", "maxAdmins", "aiRequestsLimit", "primaryColor"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new FreshInstallError("INVALID_CLIENT_CONFIG");
  const text = (key: string, max: number) => {
    const item = value[key];
    if (typeof item !== "string" || !item.trim() || item.length > max || /[\x00-\x1f\x7f]/.test(item)) throw new FreshInstallError("INVALID_CLIENT_CONFIG");
    return item.trim();
  };
  const id = text("id", 36), slug = text("slug", 63), domain = text("domain", 253), tariff = text("tariff", 30), industryTemplate = text("industryTemplate", 40);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) || !Object.hasOwn(TARIFF_FEATURES, tariff) ||
      !Object.values(INDUSTRY_TEMPLATE_CODES).includes(industryTemplate as typeof INDUSTRY_TEMPLATE_CODES[keyof typeof INDUSTRY_TEMPLATE_CODES])) throw new FreshInstallError("INVALID_CLIENT_CONFIG");
  const feature = TARIFF_FEATURES[tariff as TariffCode];
  const count = (key: string, fallback: number, minimum: number) => {
    const item = value[key] ?? fallback;
    if (!Number.isInteger(item) || Number(item) < minimum || Number(item) > 2147483647) throw new FreshInstallError("INVALID_CLIENT_CONFIG");
    return Number(item);
  };
  const primaryColor = value.primaryColor ?? null;
  if (primaryColor !== null && (typeof primaryColor !== "string" || !/^#[a-f0-9]{6}$/i.test(primaryColor))) throw new FreshInstallError("INVALID_CLIENT_CONFIG");
  return { id: id.toLowerCase(), slug, domain: domain.toLowerCase(), tariff, industryTemplate, name: text("name", 200), brandName: text("brandName", 200),
    includedUsers: count("includedUsers", feature.includedUsers, 1), maxAdmins: count("maxAdmins", feature.maxAdmins, 1),
    aiRequestsLimit: value.aiRequestsLimit === undefined || value.aiRequestsLimit === null ? null : count("aiRequestsLimit", 0, 0), primaryColor };
}

async function userRelations(sql: Connection) {
  return sql.unsafe<Array<{ name: string; schema: string; kind: string }>>(`SELECT c.relname AS name, n.nspname AS schema, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','S','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'`);
}

async function hasForeignDefinitions(sql: Connection): Promise<boolean> {
  // An application may own a database through functions/types even before it creates its first table.
  const [row] = await sql.unsafe(`SELECT
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname <> 'public' AND nspname <> 'information_schema' AND nspname !~ '^pg_') OR
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_') OR
    EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype IN ('e','d','r','m') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_') OR
    EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql') AS unexpected`);
  return row.unexpected === true;
}

export async function verifyFreshSchema(sql: Connection, marker = false): Promise<void> {
  const expected = freshSchemaShape();
  const relations = await userRelations(sql);
  const names = expected.map((table) => table.name).concat(marker ? ["core_runtime_installation"] : []).sort();
  if (await hasForeignDefinitions(sql) || relations.some((row) => row.schema !== "public" || row.kind !== "r") || JSON.stringify(relations.map((row) => row.name).sort()) !== JSON.stringify(names)) throw new FreshInstallError("SCHEMA_MISMATCH");
  const columns = await sql.unsafe<Array<{ table: string; name: string; type: string; notNull: boolean; hasDefault: boolean }>>(`SELECT c.relname AS "table", a.attname AS name,
    format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS "notNull", (d.oid IS NOT NULL) AS "hasDefault"
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind='r'`);
  // PostgreSQL 18 also lists NOT NULL here; it is already checked through pg_attribute above.
  const constraints = await sql.unsafe<Array<{ table: string; name: string; type: string }>>(`SELECT c.relname AS "table", k.conname AS name, k.contype AS type FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND k.contype IN ('p','u','f','c','x')`);
  const indexes = await sql.unsafe<Array<{ table: string; name: string }>>(`SELECT c.relname AS "table", idx.relname AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
    JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid)`);
  for (const table of expected) {
    const actual = {
      columns: ordered(columns.filter((row) => row.table === table.name).map(({ table: ignored, ...column }) => column)),
      constraints: ordered(constraints.filter((row) => row.table === table.name).map(({ table: ignored, ...key }) => key)),
      indexes: indexes.filter((row) => row.table === table.name).map((row) => row.name).sort()
    };
    if (JSON.stringify(actual) !== JSON.stringify({ columns: table.columns, constraints: table.constraints, indexes: table.indexes })) throw new FreshInstallError("SCHEMA_MISMATCH");
  }
}

export async function initializeFreshDatabase(databaseUrl: string, baseline: FreshBaseline, input: unknown) {
  const client = normalizeFreshClient(input);
  if (baseline.version !== FRESH_SCHEMA_VERSION || !/^[a-f0-9]{64}$/.test(baseline.sha256) || contentSha256(baseline.sql) !== baseline.sha256 || baseline.schemaSha256 !== freshSchemaSha256()) throw new FreshInstallError("BASELINE_MISMATCH");
  try {
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/") throw new Error("Invalid connection");
  } catch { throw new FreshInstallError("INVALID_DATABASE_CONFIG"); }
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const configSha256 = contentSha256(JSON.stringify(client));
  try {
    return await sql.begin(async (tx) => {
      // One lock per database protects the empty check, schema creation and installation marker together.
      await tx.unsafe("SET LOCAL lock_timeout TO '10s'");
      await tx.unsafe("SET LOCAL statement_timeout TO '30s'");
      await tx.unsafe("SELECT pg_advisory_xact_lock(4839216621085)");
      await tx.unsafe("SET LOCAL search_path TO public, pg_catalog");
      const relations = await userRelations(tx);
      if (relations.length > 0) {
        if (!relations.some((row) => row.schema === "public" && row.name === "core_runtime_installation" && row.kind === "r")) throw new FreshInstallError("DATABASE_NOT_EMPTY");
        const markers = await tx.unsafe("SELECT version, baseline_sha256, schema_sha256, client_config_sha256, client_id FROM public.core_runtime_installation");
        const saved = markers[0];
        if (markers.length !== 1 || saved.version !== baseline.version || saved.baseline_sha256 !== baseline.sha256 || saved.schema_sha256 !== baseline.schemaSha256 ||
            saved.client_config_sha256 !== configSha256 || saved.client_id !== client.id) throw new FreshInstallError("INSTALLATION_MISMATCH");
        await verifyFreshSchema(tx, true);
        return { initialized: true, reused: true, clientId: client.id, version: baseline.version };
      }
      if (await hasForeignDefinitions(tx)) throw new FreshInstallError("DATABASE_NOT_EMPTY");
      await tx.unsafe(baseline.sql).simple();
      await verifyFreshSchema(tx);
      await tx.unsafe(`INSERT INTO clients (id,name,slug,domain,brand_name,tariff,industry_template,included_users,max_admins,ai_requests_limit,primary_color)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [client.id, client.name, client.slug, client.domain, client.brandName, client.tariff, client.industryTemplate, client.includedUsers, client.maxAdmins, client.aiRequestsLimit, client.primaryColor]);
      for (const role of CORE_ROLES) await tx.unsafe("INSERT INTO roles (code,name,description) VALUES ($1,$2,$3)", [role.code, role.name, role.description]);
      await tx.unsafe(`CREATE TABLE public.core_runtime_installation (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version text NOT NULL,
        baseline_sha256 text NOT NULL, schema_sha256 text NOT NULL, client_config_sha256 text NOT NULL,
        client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now())`);
      await tx.unsafe("INSERT INTO public.core_runtime_installation (version,baseline_sha256,schema_sha256,client_config_sha256,client_id) VALUES ($1,$2,$3,$4,$5)",
        [baseline.version, baseline.sha256, baseline.schemaSha256, configSha256, client.id]);
      return { initialized: true, reused: false, clientId: client.id, version: baseline.version };
    });
  } catch (error) {
    if (error instanceof FreshInstallError) throw error;
    // PostgreSQL errors can contain a connection string or SQL arguments. Return only an allowlisted code.
    throw new FreshInstallError("DATABASE_INITIALIZATION_FAILED");
  } finally { await sql.end({ timeout: 5 }); }
}
