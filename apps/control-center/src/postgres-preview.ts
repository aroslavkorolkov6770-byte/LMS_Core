import { execFile } from "node:child_process";

export type PostgresTableSummary = { schema: string; name: string; rows: number; totalBytes: number };
export type PostgresSnapshot = { database: string; selectedTable: string | null; tables: PostgresTableSummary[]; rows: Array<Record<string, unknown>> };
export type PreviewQuery = (query: string) => Promise<unknown>;
type RunnerOptions = { cwd: string; windowsHide: boolean; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; input: string };
export type PreviewProcessRunner = (file: string, args: string[], options: RunnerOptions) => Promise<{ stdout: string }>;

export const runPreviewProcess: PreviewProcessRunner = (file, args, { input, ...options }) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout) => {
    if (error) reject(error);
    else resolve({ stdout });
  });
  // A Windows command line can recode Cyrillic to the ANSI code page. A UTF-8 pipe cannot.
  child.stdin?.once("error", (error) => { child.kill(); reject(error); });
  child.stdin?.end(input, "utf8");
});

function literal(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function identifier(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
function validName(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0"); }

export function localPreviewQuery(
  executable: string,
  databaseUrl: string,
  expectedPort: number,
  cwd: string,
  runner: PreviewProcessRunner = runPreviewProcess
): PreviewQuery {
  let connection: URL;
  let environment: NodeJS.ProcessEnv;
  try {
    connection = new URL(databaseUrl);
    const hostname = connection.hostname.replace(/^\[|\]$/g, "");
    if (!["postgres:", "postgresql:"].includes(connection.protocol) ||
        !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
        !Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535 || Number(connection.port || 5432) !== expectedPort ||
        !connection.username || !connection.pathname.slice(1)) throw new Error("Invalid local connection");
    environment = {
      ...process.env,
      PGHOST: hostname, PGPORT: String(expectedPort), PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: decodeURIComponent(connection.password), PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
      PGCLIENTENCODING: "UTF8", PGCONNECT_TIMEOUT: "3",
      PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=1500 -c standard_conforming_strings=on"
    };
  } catch {
    throw new Error("Параметры просмотра БД не соответствуют локальному PostgreSQL Core. Внешнее подключение не выполнялось.");
  }
  return async (query) => {
    try {
      const result = await runner(executable, ["-X", "-w", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
        cwd, windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024, env: environment, input: query
      });
      if (!result.stdout.trim()) throw new Error("Empty SQL response");
      return JSON.parse(result.stdout.trim());
    } catch (error) {
      // Driver errors can include SQL, row values or connection data. Show a bounded explanation instead.
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === "ENOENT") throw new Error("psql.exe не найден. Проверьте локальную установку PostgreSQL.");
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("Данные таблицы слишком велики для встроенного предпросмотра. Откройте pgAdmin для просмотра крупных полей.");
      if (failure.killed || failure.code === "ETIMEDOUT") throw new Error("Чтение БД превысило время ожидания. Повторите проверку или откройте pgAdmin.");
      throw new Error("Не удалось прочитать PostgreSQL. Проверьте доступ к локальной БД, ее журнал и повторите обновление.");
    }
  };
}

export async function readPostgresSnapshot(query: PreviewQuery, requestedTable?: string): Promise<PostgresSnapshot> {
  if (requestedTable !== undefined && requestedTable !== "" && !validName(requestedTable)) throw new Error("Некорректное имя таблицы.");
  const inventory = await query(`
    select json_build_object('database', current_database(), 'tables', coalesce(json_agg(
      json_build_object('schema', source.schema, 'name', source.name) order by source.name), '[]'::json))
    from (select n.nspname as schema, c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by c.relname limit 257) source;
  `) as { database?: unknown; tables?: unknown } | null;
  if (typeof inventory?.database !== "string" || !Array.isArray(inventory.tables)) throw new Error("PostgreSQL вернул неверный список таблиц.");
  if (inventory.tables.length > 256) throw new Error("Для такого количества таблиц используйте pgAdmin. Встроенный просмотр ограничен 256 таблицами.");
  const names = new Set<string>();
  const tables: Array<{ schema: string; name: string }> = inventory.tables.map((entry: unknown) => {
    const table = entry as { schema?: unknown; name?: unknown } | null;
    if (table?.schema !== "public" || !validName(table.name) || names.has(table.name)) throw new Error("PostgreSQL вернул неверное описание таблицы.");
    names.add(table.name);
    return { schema: "public", name: table.name };
  });
  const selectedTable = requestedTable || tables[0]?.name || null;
  if (selectedTable && !names.has(selectedTable)) throw new Error("Таблица больше не существует. Обновите список таблиц.");
  if (!selectedTable) return { database: inventory.database, selectedTable: null, tables: [], rows: [] };

  // All exact counts and the visible rows share one SELECT/snapshot, not one process per table.
  const counts = tables.map((table) => `select ${literal(table.schema)}::text as schema, ${literal(table.name)}::text as name,
    count(*)::bigint as rows, pg_total_relation_size(${literal(`${identifier(table.schema)}.${identifier(table.name)}`)}::regclass)::bigint as "totalBytes"
    from ${identifier(table.schema)}.${identifier(table.name)}`).join("\nunion all\n");
  const snapshot = await query(`with counted as (${counts}), visible_rows as (
      select * from public.${identifier(selectedTable)} limit 50
    ) select json_build_object('database', current_database(), 'selectedTable', ${literal(selectedTable)},
      'tables', (select json_agg(row_to_json(counted) order by name) from counted),
      'rows', (select coalesce(json_agg(row_to_json(visible_rows)), '[]'::json) from visible_rows));
  `) as Partial<PostgresSnapshot> | null;
  if (snapshot?.database !== inventory.database || snapshot.selectedTable !== selectedTable || !Array.isArray(snapshot.tables) || !Array.isArray(snapshot.rows) || snapshot.rows.length > 50) {
    throw new Error("PostgreSQL вернул неполные данные предпросмотра.");
  }
  const resultNames = new Set<string>();
  for (const table of snapshot.tables) {
    if (!table || typeof table !== "object" || table.schema !== "public" || !names.has(table.name) || resultNames.has(table.name) ||
        !Number.isSafeInteger(table.rows) || table.rows < 0 || !Number.isSafeInteger(table.totalBytes) || table.totalBytes < 0) throw new Error("PostgreSQL вернул неверные счетчики таблиц.");
    resultNames.add(table.name);
  }
  if (resultNames.size !== names.size || snapshot.rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) throw new Error("PostgreSQL вернул неполные данные предпросмотра.");
  return snapshot as PostgresSnapshot;
}
