param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Status", "Start", "Stop")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ServiceId
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$configPath = Join-Path $projectRoot "apps\control-center\config\launcher-config.json"
$secretsPath = Join-Path $projectRoot "apps\control-center\config\launcher-secrets.json"
$runtimeRoot = Join-Path $projectRoot "infra\runtime"
$pidsRoot = Join-Path $runtimeRoot "pids"
$logsRoot = Join-Path $runtimeRoot "logs"
$postgresBin = if ($env:CORE_PG_BIN) { $env:CORE_PG_BIN } else { "C:\Program Files\PostgreSQL\18\bin" }

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
New-Item -ItemType Directory -Force -Path $pidsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $logsRoot | Out-Null

$config = Get-Content -Path $configPath -Raw | ConvertFrom-Json
$service = $config.services | Where-Object { $_.id -eq $ServiceId } | Select-Object -First 1

if (-not $service) {
  throw "Service '$ServiceId' not found in launcher-config.json"
}

function Test-TcpPort {
  param(
    [int]$Port
  )

  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $success = $async.AsyncWaitHandle.WaitOne(600)

    if (-not $success) {
      $client.Close()
      return $false
    }

    $client.EndConnect($async)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

function Get-PidPath {
  param(
    [string]$ServiceName
  )

  return (Join-Path $pidsRoot "$ServiceName.pid")
}

function Get-OwnerPath {
  param([string]$ServiceName)
  return (Join-Path $pidsRoot "$ServiceName.owner.json")
}

function Get-OwnerRecord {
  param([string]$ServiceName)
  $ownerPath = Get-OwnerPath -ServiceName $ServiceName
  if (-not (Test-Path -LiteralPath $ownerPath)) { return $null }
  try {
    $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
    if ([string]$owner.serviceId -ne $ServiceName) { return $null }
    return $owner
  } catch {
    return $null
  }
}

function Get-VerifiedProcess {
  param([int]$ProcessId, [string]$StartedAtUtc)
  if ($ProcessId -le 0 -or -not $StartedAtUtc) { return $null }
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $StartedAtUtc) { return $null }
    return $process
  } catch {
    return $null
  }
}

function Test-DescendantProcess {
  param([int]$ProcessId, [int]$AncestorId)
  if ($ProcessId -le 0 -or $AncestorId -le 0) { return $false }
  if ($ProcessId -eq $AncestorId) { return $true }
  try {
    # A single consistent snapshot avoids one WMI round trip for every parent.
    $parents = @{}
    Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId -ErrorAction Stop | ForEach-Object {
      $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId
    }
  } catch { return $false }
  $currentId = $ProcessId
  for ($depth = 0; $depth -lt 20 -and $currentId -gt 0; $depth++) {
    if ($currentId -eq $AncestorId) { return $true }
    if (-not $parents.ContainsKey($currentId) -or $parents[$currentId] -eq $currentId) { return $false }
    $currentId = $parents[$currentId]
  }
  return $false
}

function Get-LogPath {
  param(
    $Svc
  )

  if ($Svc.logFile) {
    return [string]$Svc.logFile
  }

  $owner = Get-OwnerRecord -ServiceName $Svc.id
  if ($owner -and $owner.logFile) { return [string]$owner.logFile }
  return (Join-Path $logsRoot "$($Svc.id).out.log")
}

function Get-ErrorLogPath {
  param(
    $Svc
  )

  $owner = Get-OwnerRecord -ServiceName $Svc.id
  if ($owner -and $owner.errorLogFile) { return [string]$owner.errorLogFile }
  return (Join-Path $logsRoot "$($Svc.id).err.log")
}

function Get-ServicePid {
  param(
    [string]$PidPath
  )

  if (-not (Test-Path $PidPath)) {
    return $null
  }

  try {
    $value = Get-Content -Path $PidPath -Raw
    return [int]$value
  } catch {
    return $null
  }
}

function Find-CoreListenerProcessId {
  param([string[]]$Lines, [int]$Port)
  $processIds = @(
    foreach ($line in $Lines) {
      if ($line -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
        $address = $Matches[1]
        $localPort = 0
        $listenerPid = 0
        if ([int]::TryParse($Matches[2], [ref]$localPort) -and [int]::TryParse($Matches[3], [ref]$listenerPid) -and
            $localPort -eq $Port -and $listenerPid -gt 0 -and
            @("127.0.0.1", "0.0.0.0", "[::]", "[::ffff:127.0.0.1]") -contains $address) {
          $listenerPid
        }
      }
    }
  ) | Select-Object -Unique
  $unique = @($processIds)
  if ($unique.Count -eq 1) { return [int]$unique[0] }
  # Ambiguous listeners are not evidence of ownership.
  return $null
}

function Get-ProcessIdByPort {
  param(
    [int]$Port
  )

  try {
    $lines = @(netstat.exe -ano -p tcp 2>$null)
    if ($LASTEXITCODE -eq 0) {
      return Find-CoreListenerProcessId -Lines $lines -Port $Port
    }
  } catch {
    # Keep a compatible fallback if the native tool is unavailable.
  }
  try {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -First 1

    if ($connection) {
      return [int]$connection.OwningProcess
    }
  } catch {
    return $null
  }

  return $null
}

function Is-ProcessRunning {
  param(
    [int]$ProcessId
  )

  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-ServiceStatus {
  param(
    $Svc,
    [string]$Message,
    [bool]$Success = $true
  )

  $pidPath = Get-PidPath -ServiceName $Svc.id
  $portOpen = Test-TcpPort -Port ([int]$Svc.port)
  $owner = Get-OwnerRecord -ServiceName $Svc.id
  $servicePid = $null
  if ($owner) {
    $verified = Get-VerifiedProcess -ProcessId ([int]$owner.rootPid) -StartedAtUtc ([string]$owner.rootStartedAtUtc)
    if ($verified) { $servicePid = [int]$verified.Id }
  }

  $status = [ordered]@{
    id = [string]$Svc.id
    label = [string]$Svc.label
    kind = [string]$Svc.kind
    port = [int]$Svc.port
    url = [string]$Svc.url
    logFile = [string](Get-LogPath -Svc $Svc)
    errorLogFile = [string](Get-ErrorLogPath -Svc $Svc)
    pidFile = [string]$pidPath
    running = $portOpen
    portOpen = $portOpen
    pid = $servicePid
    ok = $Success
    message = if ($Message) { $Message } elseif ($portOpen) { "Локальный порт открыт." } else { "Локальный порт закрыт." }
  }

  return $status
}

function Wait-ForServicePort {
  param(
    $Svc,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -Port ([int]$Svc.port)) {
      return $true
    }

    Start-Sleep -Milliseconds 500
  }

  return $false
}

function Get-PnpmLaunchSpec {
  param(
    $Svc
  )

  $commandText = [string]$Svc.command

  if (-not $commandText.StartsWith("pnpm ")) {
    throw "Unsupported pnpm command format for service '$($Svc.id)': $commandText"
  }

  $argumentsText = $commandText.Substring(5).Trim()
  if ($argumentsText -notmatch '^--dir\s+[A-Za-z0-9_./-]+\s+(dev|start)$') {
    throw "Неподдерживаемый формат команды для сервиса '$($Svc.id)'."
  }
  $nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw "Не найден Node.js для запуска локальных сервисов." }
  if ($env:CORE_DESKTOP_MODE -eq "1" -and $Svc.id -eq "api" -and $argumentsText -eq "--dir apps/api start") {
    $compiledApi = Join-Path $projectRoot "apps\api\dist\main.js"
    if (-not (Test-Path -LiteralPath $compiledApi)) { throw "Не найдена установленная сборка API." }
    return @{ FilePath = [string]$nodeCommand.Source; ArgumentList = @($compiledApi) }
  }
  if ($Svc.id -eq "api" -and $argumentsText -eq "--dir apps/api dev") {
    $apiDirectory = Join-Path $projectRoot "apps\api"
    $compiledApi = Join-Path $apiDirectory "dist\main.js"
    $apiSource = Join-Path $apiDirectory "src"
    if (Test-Path -LiteralPath $apiSource) {
      $apiPackage = Get-Content -LiteralPath (Join-Path $apiDirectory "package.json") -Raw | ConvertFrom-Json
      if ($apiPackage.scripts.start -eq "node dist/main.js" -and -not $apiPackage.scripts.prestart -and -not $apiPackage.scripts.poststart -and -not $apiPackage.scripts.predev -and -not $apiPackage.scripts.postdev) {
        # The helper validates source/output hashes and compiles only when needed.
        return @{ FilePath = [string]$nodeCommand.Source; ArgumentList = @((Join-Path $projectRoot "infra\scripts\run-local-api.cjs")) }
      }
    }
  }
  if (@("lms-web", "deploy-panel") -contains $Svc.id -and $argumentsText -match '^--dir apps/(lms-web|deploy-panel) (dev|start)$') {
    $nextId = $Matches[1]
    $mode = $Matches[2]
    if ($nextId -ne $Svc.id) { throw "Команда Next не соответствует выбранному сервису." }
    $nextPackage = Get-Content -LiteralPath (Join-Path $projectRoot "apps\$nextId\package.json") -Raw | ConvertFrom-Json
    $nextCommand = [string]$nextPackage.scripts.$mode
    if ($nextCommand -match "^next $mode( --hostname 127\.0\.0\.1)?( --port [0-9]+)?$" -and
        -not $nextPackage.scripts.PSObject.Properties["pre$mode"] -and -not $nextPackage.scripts.PSObject.Properties["post$mode"]) {
      # Skip package-manager processes only for these known, plain Next scripts.
      return @{ FilePath = [string]$nodeCommand.Source; ArgumentList = @((Join-Path $projectRoot "infra\scripts\run-local-next.cjs"), $nextId, $mode) }
    }
  }
  $corepackCommand = Get-Command "corepack.cmd" -ErrorAction SilentlyContinue

  if (-not $corepackCommand) {
    $corepackCommand = Get-Command "corepack" -ErrorAction SilentlyContinue
  }

  if (-not $corepackCommand) {
    throw "corepack is required to launch pnpm service '$($Svc.id)', but it was not found in PATH."
  }

  $corepackJs = Join-Path (Split-Path -Parent $corepackCommand.Source) "node_modules\corepack\dist\corepack.js"
  if (-not $nodeCommand -or -not (Test-Path -LiteralPath $corepackJs)) {
    throw "Не найдены Node.js и Corepack. Проверьте установку Node.js."
  }

  return @{
    FilePath = [string]$nodeCommand.Source
    ArgumentList = @($corepackJs, "pnpm") + ($argumentsText -split '\s+')
  }
}

function Get-ServiceAppDirectory {
  param(
    $Svc
  )

  $commandText = [string]$Svc.command
  $match = [regex]::Match($commandText, "--dir\s+([^\s]+)")

  if (-not $match.Success) {
    return $null
  }

  $relativePath = $match.Groups[1].Value.Trim()
  return (Join-Path $projectRoot $relativePath)
}

function Test-IsNextService {
  param(
    $Svc
  )

  return @("deploy-panel", "lms-web") -contains [string]$Svc.id
}

function Reset-NextRuntimeArtifacts {
  param(
    $Svc
  )

  if (-not (Test-IsNextService -Svc $Svc)) {
    return
  }

  $appDirectory = Get-ServiceAppDirectory -Svc $Svc

  if (-not $appDirectory) {
    return
  }

  $nextDirectory = Join-Path $appDirectory ".next"

  if (Test-Path $nextDirectory) {
    Remove-Item -LiteralPath $nextDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Write-Json {
  param(
    $Value
  )

  $Value | ConvertTo-Json -Depth 6 -Compress
}

function Start-PnpmService {
  param(
    $Svc
  )

  $pidPath = Get-PidPath -ServiceName $Svc.id
  $status = Get-ServiceStatus -Svc $Svc -Message ""

  if ($status.running) {
    $owner = Get-OwnerRecord -ServiceName $Svc.id
    $root = if ($owner) { Get-VerifiedProcess -ProcessId ([int]$owner.rootPid) -StartedAtUtc ([string]$owner.rootStartedAtUtc) } else { $null }
    $listener = if ($owner) { Get-VerifiedProcess -ProcessId ([int]$owner.listenerPid) -StartedAtUtc ([string]$owner.listenerStartedAtUtc) } else { $null }
    $portProcessId = Get-ProcessIdByPort -Port ([int]$Svc.port)
    $ownedListener = $listener -and $portProcessId -eq $listener.Id
    $ownedDescendant = -not $ownedListener -and $root -and $portProcessId -and (Test-DescendantProcess -ProcessId $portProcessId -AncestorId $root.Id)
    if ($ownedListener -or $ownedDescendant) {
      return Get-ServiceStatus -Svc $Svc -Message "Сервис уже запущен приложением."
    }
    return Get-ServiceStatus -Svc $Svc -Message "Порт уже занят другим процессом. Он не был изменён." -Success $false
  }

  $existingOwner = Get-OwnerRecord -ServiceName $Svc.id
  if ($existingOwner) {
    $existingRoot = Get-VerifiedProcess -ProcessId ([int]$existingOwner.rootPid) -StartedAtUtc ([string]$existingOwner.rootStartedAtUtc)
    if ($existingRoot) {
      return Get-ServiceStatus -Svc $Svc -Message "Предыдущий запуск ещё выполняется. Подождите или остановите сервис." -Success $false
    }
  }

  $runId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  $logFile = Join-Path $logsRoot "$($Svc.id)-$runId.out.log"
  $errorLogFile = Join-Path $logsRoot "$($Svc.id)-$runId.err.log"

  $envMap = @{}

  if ($config.environment) {
    foreach ($property in $config.environment.PSObject.Properties) {
      $envMap[$property.Name] = [string]$property.Value
    }
  }

  if (Test-Path $secretsPath) {
    $secrets = Get-Content -Path $secretsPath -Raw | ConvertFrom-Json

    foreach ($property in $secrets.PSObject.Properties) {
      $envMap[$property.Name] = [string]$property.Value
    }
  }

  if ($Svc.environment) {
    foreach ($property in $Svc.environment.PSObject.Properties) {
      $envMap[$property.Name] = [string]$property.Value
    }
  }

  # All Core services receive the same editor origin from the launcher config.
  $previewService = $config.services | Where-Object { $_.id -eq "lms-web" } | Select-Object -First 1
  if ($previewService) {
    $previewPort = [int]$previewService.port
    if ($previewPort -lt 1024 -or $previewPort -gt 65535) { throw "Некорректный порт редактора Core." }
    $envMap["CORE_LMS_PREVIEW_ORIGIN"] = "http://127.0.0.1:$previewPort"
    $envMap["NEXT_PUBLIC_LMS_PREVIEW_ORIGIN"] = "http://127.0.0.1:$previewPort"
  }
  if (Test-IsNextService -Svc $Svc) { $envMap["PORT"] = [string]$Svc.port }

  $launchSpec = Get-PnpmLaunchSpec -Svc $Svc
  $previousEnvironmentValues = @{}

  foreach ($key in $envMap.Keys) {
    $previousEnvironmentValues[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $envMap[$key], "Process")
  }

  try {
    $spawnHelper = Join-Path $projectRoot "infra\scripts\spawn-managed-service.cjs"
    $launchArguments = @($spawnHelper, $projectRoot, $logFile, $errorLogFile) + @($launchSpec.ArgumentList)
    $quotedArguments = ($launchArguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' '
    $process = Start-Process -FilePath $launchSpec.FilePath -ArgumentList $quotedArguments `
      -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  } finally {
    foreach ($key in $envMap.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previousEnvironmentValues[$key], "Process")
    }
  }

  $owner = [ordered]@{
    serviceId = [string]$Svc.id
    rootPid = [int]$process.Id
    rootStartedAtUtc = $process.StartTime.ToUniversalTime().Ticks.ToString()
    listenerPid = 0
    listenerStartedAtUtc = ""
    logFile = $logFile
    errorLogFile = $errorLogFile
  }
  Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII
  $owner | ConvertTo-Json -Compress | Set-Content -LiteralPath (Get-OwnerPath -ServiceName $Svc.id) -Encoding UTF8
  $timeoutSeconds = if ($Svc.id -eq "api") { 90 } else { 45 }
  $portOpened = Wait-ForServicePort -Svc $Svc -TimeoutSeconds $timeoutSeconds

  if (-not $portOpened) {
    return Get-ServiceStatus -Svc $Svc -Message "Порт не открылся за $timeoutSeconds секунд. Проверьте журнал; запущенный процесс можно остановить." -Success $false
  }

  $listenerId = Get-ProcessIdByPort -Port ([int]$Svc.port)
  if ($null -eq $listenerId -or -not (Test-DescendantProcess -ProcessId $listenerId -AncestorId $process.Id)) {
    return Get-ServiceStatus -Svc $Svc -Message "Порт открыт, но принадлежность процесса не подтверждена. Проверьте журнал." -Success $false
  }
  try {
    $listener = Get-Process -Id $listenerId -ErrorAction Stop
    $owner.listenerPid = [int]$listener.Id
    $owner.listenerStartedAtUtc = $listener.StartTime.ToUniversalTime().Ticks.ToString()
    $owner | ConvertTo-Json -Compress | Set-Content -LiteralPath (Get-OwnerPath -ServiceName $Svc.id) -Encoding UTF8
  } catch {
    return Get-ServiceStatus -Svc $Svc -Message "Сервис открыл порт, но определить его процесс не удалось." -Success $false
  }

  return Get-ServiceStatus -Svc $Svc -Message "Сервис запущен приложением, порт открыт."
}

function Start-PostgresService {
  param(
    $Svc
  )

  $status = Get-ServiceStatus -Svc $Svc -Message ""

  $pgCtl = Join-Path $postgresBin "pg_ctl.exe"
  $dataDir = Join-Path $projectRoot "infra\local-postgres\data"
  $postgresLog = Join-Path $projectRoot "infra\local-postgres\postgres.log"
  if (-not (Test-Path -LiteralPath $pgCtl) -or -not (Test-Path -LiteralPath $dataDir)) {
    return Get-ServiceStatus -Svc $Svc -Message "Не найдена локальная PostgreSQL или папка её данных." -Success $false
  }

  & $pgCtl -D $dataDir status 2>&1 | Out-Null
  $projectDatabaseRunning = $LASTEXITCODE -eq 0
  if ($projectDatabaseRunning) {
    return Get-ServiceStatus -Svc $Svc -Message "Проектная PostgreSQL уже запущена."
  }
  if ($status.running) {
    return Get-ServiceStatus -Svc $Svc -Message "Порт PostgreSQL занят другим процессом. Он не был изменён." -Success $false
  }

  $arguments = '-D "{0}" -l "{1}" -o "-p {2}" -w -t 45 start' -f $dataDir, $postgresLog, ([int]$Svc.port)
  Start-Process -FilePath $pgCtl -ArgumentList $arguments -WindowStyle Hidden -PassThru | Out-Null
  if (-not (Wait-ForServicePort -Svc $Svc -TimeoutSeconds 45)) {
    return Get-ServiceStatus -Svc $Svc -Message "PostgreSQL не открыла порт за 45 секунд. Проверьте журнал базы." -Success $false
  }
  & $pgCtl -D $dataDir status 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    return Get-ServiceStatus -Svc $Svc -Message "Порт открыт, но проектная PostgreSQL не подтверждена." -Success $false
  }
  return Get-ServiceStatus -Svc $Svc -Message "Проектная PostgreSQL запущена."
}

function Stop-PnpmService {
  param(
    $Svc
  )

  $owner = Get-OwnerRecord -ServiceName $Svc.id
  if (-not $owner) {
    $status = Get-ServiceStatus -Svc $Svc -Message ""
    if ($status.running) {
      return Get-ServiceStatus -Svc $Svc -Message "Порт занят процессом, который приложение не запускало. Он не остановлен." -Success $false
    }
    return Get-ServiceStatus -Svc $Svc -Message "Сервис уже остановлен."
  }

  $root = Get-VerifiedProcess -ProcessId ([int]$owner.rootPid) -StartedAtUtc ([string]$owner.rootStartedAtUtc)
  $listener = Get-VerifiedProcess -ProcessId ([int]$owner.listenerPid) -StartedAtUtc ([string]$owner.listenerStartedAtUtc)
  $target = if ($root) { $root } else { $listener }
  if (-not $target) {
    $status = Get-ServiceStatus -Svc $Svc -Message ""
    if ($status.running) {
      return Get-ServiceStatus -Svc $Svc -Message "Владелец занятого порта не подтверждён. Процесс не остановлен." -Success $false
    }
    return Get-ServiceStatus -Svc $Svc -Message "Сервис уже остановлен."
  }

  & taskkill.exe /PID $target.Id /T /F 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0 -and (Get-VerifiedProcess -ProcessId $target.Id -StartedAtUtc ($target.StartTime.ToUniversalTime().Ticks.ToString()))) {
    return Get-ServiceStatus -Svc $Svc -Message "Не удалось остановить процесс сервиса." -Success $false
  }

  $deadline = (Get-Date).AddSeconds(8)
  while ((Test-TcpPort -Port ([int]$Svc.port)) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  $status = Get-ServiceStatus -Svc $Svc -Message ""
  if ($status.running) {
    return Get-ServiceStatus -Svc $Svc -Message "После остановки процесса порт всё ещё занят. Проверьте сервис." -Success $false
  }
  return Get-ServiceStatus -Svc $Svc -Message "Процесс сервиса остановлен."
}

switch ($Action) {
  "Status" {
    Write-Json (Get-ServiceStatus -Svc $service -Message "")
    break
  }
  "Start" {
    if ($service.kind -eq "postgres") {
      Write-Json (Start-PostgresService -Svc $service)
      break
    }

    Write-Json (Start-PnpmService -Svc $service)
    break
  }
  "Stop" {
    if ($service.kind -eq "postgres") {
      $pgCtl = Join-Path $postgresBin "pg_ctl.exe"
      $dataDir = Join-Path $projectRoot "infra\local-postgres\data"
      if (-not (Test-Path -LiteralPath $pgCtl) -or -not (Test-Path -LiteralPath $dataDir)) {
        Write-Json (Get-ServiceStatus -Svc $service -Message "Не найдена проектная PostgreSQL или папка её данных." -Success $false)
        break
      }
      & $pgCtl -D $dataDir status 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        $status = Get-ServiceStatus -Svc $service -Message ""
        if ($status.running) {
          Write-Json (Get-ServiceStatus -Svc $service -Message "Порт занят не проектной PostgreSQL. Посторонний процесс не остановлен." -Success $false)
        } else {
          Write-Json (Get-ServiceStatus -Svc $service -Message "Проектная PostgreSQL уже остановлена.")
        }
        break
      }
      & $pgCtl -D $dataDir -w -t 30 -m fast stop 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Json (Get-ServiceStatus -Svc $service -Message "Не удалось остановить проектную PostgreSQL." -Success $false)
      } else {
        Write-Json (Get-ServiceStatus -Svc $service -Message "Проектная PostgreSQL остановлена.")
      }
      break
    }

    Write-Json (Stop-PnpmService -Svc $service)
    break
  }
}
