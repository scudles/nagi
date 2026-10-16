param(
  [Parameter(Mandatory=$true)][string]$OutFile,
  [Parameter(Mandatory=$true)][string]$Processes
)
# Nagi player-title probe: read the MAIN WINDOW TITLE of whitelisted media player
# processes only (comma-separated process names, case-insensitive).
# Privacy boundary: no other process is queried, nothing is persisted by this script.
#
# Why Get-Process instead of Win32 EnumWindows:
#   players are usually minimised while the user does something else, and
#   IsWindowVisible() returns FALSE for minimised windows -- EnumWindows would
#   silently miss the very case we care about ("music playing in the background").
#   Process.MainWindowTitle is populated regardless of visibility.
#
# Output (UTF-8 JSON): { available: true, windows: [{ process, title }] }
# NOTE: keep this file ASCII-only, or save it as UTF-8 WITH BOM -- Windows
# PowerShell 5.1 parses BOM-less .ps1 files in the system code page (GBK on
# Chinese Windows) and Chinese comments get mangled.
$ErrorActionPreference = 'SilentlyContinue'
$wanted = @()
foreach ($p in $Processes.Split(',')) {
  $n = $p.Trim()
  if ($n) { $wanted += $n }
}

# One single lookup for all whitelisted names (Get-Process accepts an array).
# Do NOT query one name at a time: every Get-Process call walks the whole process
# table, and nine of them back to back can take >10s on a loaded machine -- the
# caller then reports a timeout and the whole media context is lost (hit on
# 2026-10-17). Only whitelisted names are ever queried (privacy boundary intact).
$entries = @()
if ($wanted.Count -gt 0) {
  foreach ($proc in @(Get-Process -Name $wanted -ErrorAction SilentlyContinue)) {
    $title = [string]$proc.MainWindowTitle
    $title = $title -replace "[\t\r\n]", " "
    $title = $title.Trim()
    if ($title.Length -gt 0) {
      $entries += [ordered]@{ process = [string]$proc.ProcessName; title = $title }
    }
  }
}
$result = @{ available = $true; windows = $entries }
[System.IO.File]::WriteAllText($OutFile, ($result | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding $false))
