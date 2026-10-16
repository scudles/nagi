param([Parameter(Mandatory=$true)][string]$OutFile)
# Nagi geo probe: Windows location API (WinRT Geolocator).
# On machines without location services or with the location permission off,
# the Geolocator type may not even load -- the caller falls back to IP-based
# geolocation in that case.
# Output (UTF-8 JSON): { available: true, lat, lon, accuracyMeters, source: "windows-api" }
# or { available: false, reason }
# NOTE: keep this file ASCII-only, or save it as UTF-8 WITH BOM -- Windows
# PowerShell 5.1 parses BOM-less .ps1 files in the system code page (GBK on
# Chinese Windows) and Chinese comments get mangled.
$ErrorActionPreference = 'Stop'
$result = @{ available = $false; reason = 'unknown' }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $locator = New-Object Windows.Devices.Geolocation.Geolocator
  $op = $locator.GetGeopositionAsync()
  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Length -eq 1 }
  $generic = $methods | Where-Object { $_.GetGenericArguments().Count -eq 1 } | Select-Object -First 1
  $task = $generic.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition]).Invoke($null, @($op))
  if (-not $task.Wait(10000)) {
    $result = @{ available = $false; reason = 'timeout' }
  } else {
    $p = $task.Result
    $result = @{
      available = $true
      lat = $p.Coordinate.Point.Position.Latitude
      lon = $p.Coordinate.Point.Position.Longitude
      accuracyMeters = $p.Coordinate.Accuracy
      source = 'windows-api'
    }
  }
} catch {
  $result = @{ available = $false; reason = $_.Exception.Message }
}
[System.IO.File]::WriteAllText($OutFile, ($result | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding $false))
