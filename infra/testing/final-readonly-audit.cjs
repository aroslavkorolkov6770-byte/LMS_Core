const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { localPreviewQuery } = require("../../apps/control-center/dist/postgres-preview.js");
const { checkHttpHealth, checkLocalPage } = require("../../apps/control-center/dist/service-health.js");
const { ExecutionPolicy } = require("../../apps/control-center/dist/execution-policy.js");
const root = path.resolve(__dirname, "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);

(async () => {
  const config = JSON.parse(await fs.readFile(path.join(root, "apps/control-center/config/launcher-config.json"), "utf8"));
  let secrets = {};
  try { secrets = JSON.parse((await fs.readFile(path.join(root, "apps/control-center/config/launcher-secrets.json"), "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code !== "ENOENT") throw Error("LOCAL_CONFIGURATION_UNREADABLE"); }
  const postgres = config.services.find((service) => service.id === "postgres");
  assert.equal(postgres.port, 55432);
  const environment = { ...config.environment, ...secrets, ...postgres.environment };
  const query = localPreviewQuery("C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe", environment.DATABASE_URL, postgres.port, root);
  const database = await query(`SELECT json_build_object(
    'readOnly', current_setting('transaction_read_only') = 'on',
    'tables', (SELECT count(*) FROM pg_tables WHERE schemaname='public'),
    'clients', (SELECT count(*) FROM public.clients),
    'users', (SELECT count(*) FROM public.users),
    'courses', (SELECT count(*) FROM public.courses),
    'temporaryCoreDatabases', (SELECT count(*) FROM pg_database WHERE datname ~ '^core_(baseline|bundle|lms|runtime)_test_[a-f0-9]{16}$'),
    'managedLmsDatabases', (SELECT count(*) FROM pg_database WHERE datname ~ '^lms_[a-f0-9]{32}$'),
    'managedLmsRoles', (SELECT count(*) FROM pg_roles WHERE rolname ~ '^lms_role_[a-f0-9]{32}$')
  );`);
  const services = [];
  for (const [id, identity] of [["api", "lms-core-api"], ["lms-web", "lms-core-lms-web"], ["deploy-panel", "lms-core-deploy-panel"]]) {
    const service = config.services.find((item) => item.id === id);
    assert.ok(Number.isInteger(service?.port) && service.port > 0 && service.port <= 65535);
    const origin = `http://127.0.0.1:${service.port}`;
    const check = await checkHttpHealth(`${origin}/api/health`, identity);
    const page = id === "api" ? null : await checkLocalPage(origin, 10000);
    services.push({ id, port: service.port, identity: check.healthState, page: page?.healthState ?? null });
  }
  const preferenceFile = path.join(process.env.APPDATA, "@lms-core/control-center/interface-preferences.json");
  const before = await fs.readFile(preferenceFile);
  // Only process identities/counts and listener ports leave PowerShell, never command lines or secrets.
  const powershell = `$ErrorActionPreference='Stop';$all=Get-CimInstance Win32_Process;$core=@($all|Where-Object {$_.Name -eq 'electron.exe' -and $_.CommandLine -like '*Desktop*LMS Core*' -and $_.CommandLine -notlike '*--type=*'});$listeners=@(Get-NetTCPConnection -State Listen|Where-Object {$_.LocalPort -in @(3000,3001,3002,3100,55432)});$pilot=$all|Where-Object ProcessId -eq 9096;[pscustomobject]@{coreMainPids=@($core|Where-Object {$_.CommandLine -notlike '*native-*entry.cjs*'}|ForEach-Object {$_.ProcessId});testMainPids=@($core|Where-Object {$_.CommandLine -like '*native-*entry.cjs*'}|ForEach-Object {$_.ProcessId});persistentLauncherHelpers=@($all|Where-Object {$_.ProcessId -ne $PID -and $_.Name -in @('node.exe','cmd.exe','powershell.exe') -and $_.CommandLine -like '*start-control-center*'}).Count;listenerPorts=@($listeners.LocalPort|Sort-Object -Unique);pilotPid=if($listeners|Where-Object {$_.LocalPort -eq 3000 -and $_.OwningProcess -eq 9096}){9096}else{$null};pilotStarted=if($pilot){$pilot.CreationDate.ToString('o')}else{$null}}|ConvertTo-Json -Compress`;
  const result = await run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershell], { windowsHide: true, timeout: 20000, maxBuffer: 32768 });
  const processes = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  const receipt = { checkedAt: new Date().toISOString(), readOnlySql: database.readOnly, database, services, processes, executionMode: await new ExecutionPolicy(root).mode(), ownerPreferencesUnchanged: hash(before) === hash(await fs.readFile(preferenceFile)), theme: JSON.parse(before).preferences.theme, externalActions: false };
  const output = path.join(root, "infra/runtime/local-acceptance/final-audit-20261029", randomUUID());
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, output }));
  assert.equal(database.readOnly, true);
  assert.equal(database.temporaryCoreDatabases, 0);
  assert.equal(receipt.ownerPreferencesUnchanged, true);
  assert.equal(receipt.executionMode, "local");
  assert.ok(services.every((service) => service.identity === "healthy" && (service.page === null || service.page === "healthy")));
  assert.equal(processes.testMainPids.length, 0);
})().catch(() => { console.error("Read-only audit was not accepted. Inspect the bounded receipt; connection strings were not printed."); process.exitCode = 1; });
