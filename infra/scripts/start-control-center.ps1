$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$appRoot = Join-Path $projectRoot "apps\control-center"
$tscPath = Join-Path $appRoot "node_modules\.bin\tsc.cmd"
$electronPath = Join-Path $appRoot "node_modules\electron\dist\electron.exe"
$startupLog = Join-Path $projectRoot "infra\runtime\logs\control-center-startup.log"

function New-CoreElectronStartInfo {
  param([string]$Executable, [string]$WorkingDirectory)
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Executable
  $info.Arguments = "."
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  # Inherit the normal environment, but never start Electron as a Node-only helper.
  # This changes the child's copy only, not Windows or the parent process.
  $info.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE")
  return $info
}

try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $startupLog) | Out-Null
  Set-Location -LiteralPath $appRoot

  if (-not (Test-Path -LiteralPath $electronPath)) {
    throw "Не найден Electron. Проверьте установку зависимостей проекта."
  }

  $needsBuild = $false
  $sourceRoot = Join-Path $appRoot "src"
  foreach ($source in (Get-ChildItem -LiteralPath $sourceRoot -Filter "*.ts" -File -Recurse)) {
    $relativeSource = $source.FullName.Substring($sourceRoot.Length + 1)
    $compiled = Join-Path $appRoot (Join-Path "dist" ([System.IO.Path]::ChangeExtension($relativeSource, ".js")))
    if (-not (Test-Path -LiteralPath $compiled) -or
        $source.LastWriteTimeUtc -gt (Get-Item -LiteralPath $compiled).LastWriteTimeUtc) {
      $needsBuild = $true
      break
    }
  }

  if ($needsBuild) {
    if (-not (Test-Path -LiteralPath $tscPath)) {
      throw "Не найден TypeScript для сборки приложения. Проверьте установку зависимостей проекта."
    }
    & $tscPath --project (Join-Path $appRoot "tsconfig.json") *>> $startupLog
    if ($LASTEXITCODE -ne 0) {
      throw "Не удалось собрать приложение. Подробности находятся в журнале запуска."
    }
  }

  $process = [System.Diagnostics.Process]::Start((New-CoreElectronStartInfo -Executable $electronPath -WorkingDirectory $appRoot))
  if (-not $process) { throw "Windows не создала процесс приложения." }
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
      $process.Refresh()
      if ($process.HasExited) {
        if ($process.ExitCode -ne 0) { throw "Приложение завершилось с кодом $($process.ExitCode)." }
        # A duplicate process exits successfully after focusing the existing window.
        return
      }
      if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
        Add-Content -LiteralPath $startupLog -Value "[$(Get-Date -Format o)] Окно Core открыто, PID $($process.Id)." -Encoding UTF8
        return
      }
      Start-Sleep -Milliseconds 100
    }
    throw "Процесс Core запущен, но окно не появилось за 30 секунд. Процесс не был принудительно остановлен; проверьте журнал приложения."
  } finally {
    # Releasing the handle does not stop Electron. No shell/Node wrapper needs to live with the app.
    $process.Dispose()
  }
} catch {
  $message = "Не удалось запустить LMS Core: $($_.Exception.Message)`n`nЖурнал: $startupLog"
  try {
    Add-Content -LiteralPath $startupLog -Value "[$(Get-Date -Format o)] $message" -Encoding UTF8
  } catch {
    # The on-screen message remains available even if the log cannot be written.
  }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($message, "LMS Core", "OK", "Error") | Out-Null
  exit 1
}
