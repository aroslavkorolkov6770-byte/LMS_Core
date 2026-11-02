"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const demand = (ok, code) => { if (!ok) throw Error(code); };
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function clientSnapshot(sql, clientId) {
  demand(UUID.test(clientId), "CLIENT_DELETE_ID_INVALID");
  const [client] = await sql.unsafe("SELECT * FROM public.clients WHERE id=$1::uuid", [clientId]);
  demand(client, "Клиент уже удален или не найден.");
  return { client, hash: hash(client) };
}

async function finalizeClientDeletion(sql, input, archive) {
  demand(UUID.test(input.clientId) && UUID.test(input.operationId) && /^[a-f0-9]{64}$/.test(input.snapshotHash), "CLIENT_DELETE_PROOF_INVALID");
  demand(input.proof?.databaseDeleted === true || input.proof?.neverInstalled === true, "CLIENT_DELETE_DATABASE_REQUIRED");
  return sql.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    const list = await tx.unsafe(`SELECT c.relname AS name, EXISTS(SELECT 1 FROM information_schema.columns a WHERE a.table_schema='public' AND a.table_name=c.relname AND a.column_name='client_id') AS scoped FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`);
    demand(list.some(t => t.name === "clients") && list.some(t => t.name === "users"), "CLIENT_DELETE_CORE_SCHEMA_INVALID");
    // Freeze Core writes while validating the snapshot and all other clients' rows.
    await tx.unsafe("LOCK TABLE " + list.map(t => "public." + identifier(t.name)).join(",") + " IN SHARE ROW EXCLUSIVE MODE");
    const current = await clientSnapshot(tx, input.clientId);
    demand(current.hash === input.snapshotHash, "Карточка изменилась. Повторите удаление после проверки данных.");
    const before = {}, removed = {};
    for (const table of list) {
      const target = table.name === "clients" ? "id" : table.scoped ? "client_id" : null;
      const retained = target ? `WHERE ${identifier(target)} IS DISTINCT FROM $1::uuid` : "";
      before[table.name] = (await tx.unsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS contents FROM public.${identifier(table.name)} t ${retained}`, target ? [input.clientId] : []))[0].contents;
      if (target) removed[table.name] = await tx.unsafe(`SELECT * FROM public.${identifier(table.name)} WHERE ${identifier(target)}=$1::uuid`, [input.clientId]);
    }
    // Repair the two known legacy omissions only here; this is not the LMS schema baseline.
    for (const table of ["documents", "tests"]) {
      const foreign = await tx.unsafe(`SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.contype='f' AND c.conrelid=$1::regclass AND c.confrelid='public.clients'::regclass AND a.attname='client_id'`, ["public." + table]);
      if (!foreign.length) await tx.unsafe(`ALTER TABLE public.${identifier(table)} ADD CONSTRAINT ${identifier(table + "_client_delete_fk")} FOREIGN KEY(client_id) REFERENCES public.clients(id) ON DELETE CASCADE`);
    }
    // Archive is encrypted by the OS in the native process, before any row is removed.
    const backup = await archive({ version: 1, operationId: input.operationId, clientId: input.clientId, rows: removed });
    for (const table of ["documents", "tests"]) await tx.unsafe(`DELETE FROM public.${identifier(table)} WHERE client_id=$1::uuid`, [input.clientId]);
    await tx.unsafe("DELETE FROM public.clients WHERE id=$1::uuid", [input.clientId]);
    for (const table of list) {
      const target = table.name === "clients" ? "id" : table.scoped ? "client_id" : null;
      const value = (await tx.unsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS contents FROM public.${identifier(table.name)} t ${target ? `WHERE ${identifier(target)} IS DISTINCT FROM $1::uuid` : ""}`, target ? [input.clientId] : []))[0].contents;
      demand(value === before[table.name], "CLIENT_DELETE_OTHER_CLIENT_CHANGED_ROLLBACK");
      if (target) demand(!(await tx.unsafe(`SELECT 1 FROM public.${identifier(table.name)} WHERE ${identifier(target)}=$1::uuid LIMIT 1`, [input.clientId])).length, "CLIENT_DELETE_CASCADE_INCOMPLETE");
    }
    // Ordinary audit_log cascades with a client; keep deletion events outside that cascade.
    await tx.unsafe("CREATE SCHEMA IF NOT EXISTS core_control");
    await tx.unsafe("CREATE TABLE IF NOT EXISTS core_control.client_deletions(operation_id uuid PRIMARY KEY,client_id uuid NOT NULL,client_name text NOT NULL,deleted_at timestamptz NOT NULL DEFAULT now(),actor text NOT NULL,proof jsonb NOT NULL,backup text NOT NULL)");
    await tx.unsafe("INSERT INTO core_control.client_deletions(operation_id,client_id,client_name,actor,proof,backup) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6)", [input.operationId, input.clientId, current.client.name, "local-core-owner", JSON.stringify(input.proof), backup]);
    return { phase: "deleted", clientId: input.clientId, operationId: input.operationId, backup };
  });
}

async function privateArchive(root, operationId, value, codec) {
  demand(UUID.test(operationId) && codec.available(), "Защищенное хранилище Windows недоступно. Клиент не удален.");
  const directory = path.resolve(root, "infra/backups/client-deletions");
  await fs.mkdir(directory, { recursive: true });
  for (let part = directory; part !== path.resolve(root); part = path.dirname(part)) demand(!(await fs.lstat(part)).isSymbolicLink(), "CLIENT_DELETE_ARCHIVE_LINK");
  const file = path.join(directory, operationId + ".dpapi");
  await fs.writeFile(file, codec.encrypt(JSON.stringify(value)), { flag: "wx", mode: 0o600 });
  return file;
}
module.exports = { clientSnapshot, finalizeClientDeletion, privateArchive };
