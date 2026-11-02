const test = require("node:test");
const assert = require("node:assert/strict");
const { localPreviewQuery, readPostgresSnapshot, runPreviewProcess } = require("../dist/postgres-preview.js");
const { testDatabase } = require("./fresh-install-test-helper.cjs");
const { root } = require("./runtime-test-helper.cjs");
const executable = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const inventory = { database: "fixture", tables: [{ schema: "public", name: "clients" }, { schema: "public", name: "users" }] };
const snapshot = { database: "fixture", selectedTable: "users", tables: [{ schema: "public", name: "clients", rows: 0, totalBytes: 8192 }, { schema: "public", name: "users", rows: 7, totalBytes: 16384 }], rows: [{ id: 1, name: "Fixture" }] };

test("database preview: exact counts and rows use two queries regardless of table count", async () => {
  const tables = Array.from({ length: 20 }, (_, index) => ({ schema: "public", name: `table_${index}` }));
  const calls = [];
  const result = await readPostgresSnapshot(async (query) => {
    calls.push(query);
    return calls.length === 1 ? { database: "fixture", tables } : { database: "fixture", selectedTable: "table_3", tables: tables.map((table) => ({ ...table, rows: 3, totalBytes: 8192 })), rows: [{ id: 7 }] };
  }, "table_3");
  assert.equal(calls.length, 2);
  assert.equal(result.tables.length, 20);
  assert.equal(result.tables[0].rows, 3);
  assert.equal((calls[1].match(/count\(\*\)/g) || []).length, 20);
  assert.match(calls[1], /limit 50/);
});

test("database preview: an empty schema needs one query and no fabricated selected table", async () => {
  let calls = 0;
  const result = await readPostgresSnapshot(async () => { calls++; return { database: "fixture", tables: [] }; });
  assert.equal(calls, 1);
  assert.deepEqual(result, { database: "fixture", selectedTable: null, tables: [], rows: [] });
});

test("database preview: an unknown table is refused before a row query", async () => {
  let calls = 0;
  await assert.rejects(readPostgresSnapshot(async () => { calls++; return inventory; }, "not_in_inventory"), /больше не существует/);
  assert.equal(calls, 1);
});

test("database preview: malformed input and invalid inventory are not treated as zero rows", async () => {
  for (const name of [null, 42, [], "nul\0name", "x".repeat(257)]) await assert.rejects(readPostgresSnapshot(async () => { throw Error("Must not query"); }, name), /Некорректное имя/);
  for (const value of [null, {}, { database: "fixture", tables: null }, { database: "fixture", tables: [null] }, { database: "fixture", tables: [{ schema: "private", name: "users" }] }, { database: "fixture", tables: [inventory.tables[0], inventory.tables[0]] }]) {
    await assert.rejects(readPostgresSnapshot(async () => value), /неверн/);
  }
  await assert.rejects(readPostgresSnapshot(async () => ({ database: "fixture", tables: Array(257).fill(inventory.tables[0]) })), /256/);
});

test("database preview: invalid counts, partial results and oversized row arrays are rejected", async () => {
  const invalid = [
    { ...snapshot, selectedTable: "clients" }, { ...snapshot, database: "other" },
    { ...snapshot, tables: [snapshot.tables[0]] }, { ...snapshot, tables: [null] },
    { ...snapshot, tables: [{ ...snapshot.tables[0], rows: -1 }, snapshot.tables[1]] },
    { ...snapshot, tables: [{ ...snapshot.tables[0], rows: Number.MAX_SAFE_INTEGER + 1 }, snapshot.tables[1]] },
    { ...snapshot, tables: [snapshot.tables[0], snapshot.tables[0]] },
    { ...snapshot, rows: Array(51).fill({ id: 1 }) }, { ...snapshot, rows: [null] }
  ];
  for (const bad of invalid) {
    let calls = 0;
    await assert.rejects(readPostgresSnapshot(async () => ++calls === 1 ? inventory : bad, "users"), /неверн|неполн/);
  }
});

test("database preview: runner targets only the configured local port and never puts credentials in argv", async () => {
  let seen;
  const query = localPreviewQuery("fixture-psql", "postgresql://fixture:private%3Avalue@127.0.0.1:55432/fixture_db", 55432, root, async (file, args, options) => {
    seen = { file, args, options };
    return { stdout: '{"ok":true}\n' };
  });
  assert.deepEqual(await query("SELECT fixture"), { ok: true });
  assert.equal(seen.options.env.PGPASSWORD, "private:value");
  assert.equal(seen.options.env.PGDATABASE, "fixture_db");
  assert.equal(seen.args.some((arg) => arg.includes("private")), false);
  assert.equal(seen.args.includes("SELECT fixture"), false);
  assert.equal(seen.options.input, "SELECT fixture");
  assert.match(seen.options.env.PGOPTIONS, /default_transaction_read_only=on/);
  assert.match(seen.options.env.PGOPTIONS, /statement_timeout=8000/);
  assert.equal(seen.options.maxBuffer, 8 * 1024 * 1024);
  for (const url of ["postgresql://fixture:secret@remote.invalid:55432/fixture", "postgresql://fixture@127.0.0.1:5432/fixture", "https://127.0.0.1:55432/fixture"]) assert.throws(() => localPreviewQuery("psql", url, 55432, root), /локальному PostgreSQL/);
});

test("database preview: failed processes and malformed output never expose raw SQL, values or passwords", async () => {
  for (const error of [new Error("private:value SQL row data"), Object.assign(new Error("private:value"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), Object.assign(new Error("private:value"), { killed: true }), Object.assign(new Error("private:value"), { code: "ENOENT" })]) {
    const query = localPreviewQuery("psql", "postgresql://fixture@127.0.0.1:55432/fixture", 55432, root, async () => { throw error; });
    await assert.rejects(query("SELECT private:value"), (failure) => !failure.message.includes("private:value"));
  }
  const query = localPreviewQuery("psql", "postgresql://fixture@127.0.0.1:55432/fixture", 55432, root, async () => ({ stdout: "private:value not-json" }));
  await assert.rejects(query("SELECT 1"), (error) => !error.message.includes("private:value"));
});

test("database preview: real PostgreSQL keeps exact counts, unicode/quoted names and read-only transactions", { timeout: 45000 }, async (t) => {
  const fixture = await testDatabase(t, "baseline");
  await fixture.sql.unsafe("CREATE TABLE public.preview_rows (id integer primary key, caption text)");
  await fixture.sql.unsafe("INSERT INTO public.preview_rows SELECT value, 'Preview fixture ' || value FROM generate_series(1,80) value");
  const unusual = 'данные \' A"';
  const quote = (value) => '"' + value.replace(/"/g, '""') + '"';
  await fixture.sql.unsafe(`CREATE TABLE public.${quote(unusual)} (caption text)`);
  await fixture.sql.unsafe(`INSERT INTO public.${quote(unusual)} VALUES ('Fixture')`);
  const calls = [];
  const query = localPreviewQuery(executable, fixture.databaseUrl, 55432, root, async (file, args, options) => {
    calls.push(args);
    return runPreviewProcess(file, args, options);
  });
  const rows = await readPostgresSnapshot(query, "preview_rows");
  assert.equal(calls.length, 2);
  assert.equal(rows.tables.find((table) => table.name === "preview_rows").rows, 80);
  assert.equal(rows.rows.length, 50);
  const other = await readPostgresSnapshot(query, unusual);
  assert.equal(other.tables.find((table) => table.name === unusual).rows, 1);
  assert.deepEqual(other.rows, [{ caption: "Fixture" }]);
  await assert.rejects(query("INSERT INTO public.preview_rows VALUES (1000, 'Should not write') RETURNING row_to_json(preview_rows)"), /Не удалось прочитать PostgreSQL/);
  assert.equal((await fixture.sql.unsafe("SELECT count(*)::int AS count FROM public.preview_rows"))[0].count, 80);
});
