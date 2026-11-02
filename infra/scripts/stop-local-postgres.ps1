$pgCtl = "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$dataDir = Join-Path $projectRoot "infra\local-postgres\data"

& $pgCtl -D $dataDir stop
