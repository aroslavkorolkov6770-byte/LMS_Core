$pgCtl = "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$dataDir = Join-Path $projectRoot "infra\local-postgres\data"
$logFile = Join-Path $projectRoot "infra\local-postgres\postgres.log"

& $pgCtl -D $dataDir -l $logFile -o "-p 55432" -w -t 45 start
