param(
    [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'LMS Core Control Center.lnk')
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$icon = Join-Path $root 'apps/control-center/renderer/assets/core-mark.ico'
if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) { throw 'The existing Core shortcut was not found.' }
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'Build the Core icon before updating its shortcut.' }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$target = $shortcut.TargetPath
$arguments = $shortcut.Arguments
$workingDirectory = $shortcut.WorkingDirectory
$backupDirectory = Join-Path $root 'infra/runtime/shortcut-backups'
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$backup = Join-Path $backupDirectory ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.lnk')
Copy-Item -LiteralPath $ShortcutPath -Destination $backup
# Change only the picture. The hidden launcher and its existing arguments stay untouched.
$shortcut.IconLocation = $icon + ',0'
$shortcut.Save()
$verified = $shell.CreateShortcut($ShortcutPath)
if ($verified.TargetPath -ne $target -or $verified.Arguments -ne $arguments -or $verified.WorkingDirectory -ne $workingDirectory) {
    throw 'Unexpected shortcut changes detected. Its original copy is kept in shortcut-backups.'
}
[pscustomobject]@{ IconLocation = $verified.IconLocation; LauncherPreserved = $true; Backup = $backup } | ConvertTo-Json
