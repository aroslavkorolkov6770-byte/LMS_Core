param([ValidatePattern('^[a-z0-9-]{1,40}$')][string]$Label = 'measurement')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LMS Core Control Center.lnk'
$output = Join-Path $root (Join-Path 'infra\runtime\local-acceptance\launcher-20261029' ([guid]::NewGuid().ToString()))
function Get-CoreMain {
    @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.CommandLine -notmatch '--type=' })
}
if (-not (Test-Path -LiteralPath $shortcut)) { throw 'The actual desktop shortcut is missing.' }
if ((Get-CoreMain).Count -ne 0) { throw 'Close the ordinary Core window gracefully before measuring a fresh shortcut launch.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$clock = [Diagnostics.Stopwatch]::StartNew()
Start-Process -FilePath $shortcut -WindowStyle Hidden
$main = $null
while ($clock.Elapsed.TotalSeconds -lt 40) {
    $candidates = Get-CoreMain
    if ($candidates.Count -gt 1) { throw 'Unexpected duplicate Core main processes.' }
    if ($candidates.Count -eq 1) {
        $process = Get-Process -Id $candidates[0].ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne 0) { $main = $candidates[0]; break }
    }
    Start-Sleep -Milliseconds 100
}
if (-not $main) { throw 'The shortcut did not expose its own Core window within the measurement deadline; no process was killed.' }
$windowMs = [math]::Round($clock.Elapsed.TotalMilliseconds)
$snapshot = @(Get-CimInstance Win32_Process)
$chain = @(); $cursor = $main
for ($depth = 0; $depth -lt 10 -and $cursor; $depth++) {
    if ($depth -gt 0 -and $cursor.Name -notin @('node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe')) { break }
    $memory = Get-Process -Id $cursor.ProcessId -ErrorAction SilentlyContinue
    $chain += [pscustomobject]@{ pid = [int]$cursor.ProcessId; name = $cursor.Name; parentPid = [int]$cursor.ParentProcessId; workingSetMiB = if ($memory) { [math]::Round($memory.WorkingSet64 / 1MB, 1) } else { $null } }
    $parentId = $cursor.ParentProcessId
    $cursor = $snapshot | Where-Object ProcessId -eq $parentId | Select-Object -First 1
}
$receipt = [ordered]@{ checkedAt = (Get-Date).ToUniversalTime().ToString('o'); label = $Label; actualDesktopShortcut = $true; visibleWindowMs = $windowMs; mainPid = [int]$main.ProcessId; chainAtVisible = $chain; servicesStartedOrStopped = $false; externalActions = $false; output = $output }
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'receipt.json') -Encoding UTF8
$receipt | ConvertTo-Json -Depth 6 -Compress
