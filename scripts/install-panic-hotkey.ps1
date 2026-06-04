# install-panic-hotkey.ps1 — Windows panic stop for clawdcursor.
#
# Creates a global keyboard shortcut (default Ctrl+Alt+K) that FORCE-KILLS every
# running clawdcursor process — the daemon and its PowerShell UIA/OCR children —
# instantly, for when an autonomous run misbehaves. No dependencies (uses a
# Desktop shortcut's built-in HotKey; the .lnk must stay on the Desktop for the
# hotkey to stay registered).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-panic-hotkey.ps1            # Ctrl+Alt+K
#   powershell -ExecutionPolicy Bypass -File install-panic-hotkey.ps1 -HotKey "CTRL+ALT+Q"
param([string]$HotKey = 'CTRL+ALT+K')

$ErrorActionPreference = 'Stop'

# 1) Write the force-kill script to a stable, install-independent location.
$dir = Join-Path $env:USERPROFILE '.clawdcursor'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$kill = Join-Path $dir 'panic-kill.ps1'
$body = @'
# clawdcursor PANIC KILL — force-stop every clawdcursor process immediately.
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'clawdcursor' -or $_.CommandLine -match 'cli\.js.*agent' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'ps-bridge\.ps1' -or $_.CommandLine -match 'ocr-recognize\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
'@
Set-Content -Path $kill -Value $body -Encoding UTF8

# 2) Desktop shortcut whose HotKey Windows registers globally.
$ws = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Stop ClawdCursor.lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath   = 'powershell.exe'
$lnk.Arguments    = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$kill`""
$lnk.HotKey       = $HotKey
$lnk.IconLocation = 'powershell.exe,0'
$lnk.Description   = 'Force-kill all clawdcursor processes (panic stop)'
$lnk.WindowStyle  = 7
$lnk.Save()

Write-Host "[OK] Panic hotkey installed: $HotKey  ->  $lnkPath"
Write-Host "     Press $HotKey anytime to force-kill clawdcursor."
Write-Host "     (Keep 'Stop ClawdCursor.lnk' on the Desktop for the hotkey to stay active.)"
