param([Parameter(Mandatory=$true)][string]$OutFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
function Wait-Operation($operation, $resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Length -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}
$manager = Wait-Operation ($managerType::RequestAsync()) $managerType
# Enumerate ALL sessions, not just GetCurrentSession():
# multiple apps can hold media sessions at once (browser video + music player),
# and the "current" session is only the most recently touched one.
$sessions = @()
foreach ($session in $manager.GetSessions()) {
  try {
    $props = Wait-Operation ($session.TryGetMediaPropertiesAsync()) $propsType
    $status = $session.GetPlaybackInfo().PlaybackStatus.ToString()
    $updated = 0
    try { $updated = [int64]([DateTimeOffset]$session.GetPlaybackInfo().Updated).ToUnixTimeMilliseconds() } catch { }
    $sessions += [ordered]@{
      app = [string]$session.SourceAppUserModelId
      title = [string]$props.Title
      artist = [string]$props.Artist
      playbackStatus = [string]$status
      updatedAt = $updated
    }
  } catch {
    $sessions += [ordered]@{ app = [string]$session.SourceAppUserModelId; title = ''; artist = ''; playbackStatus = 'Unknown'; updatedAt = 0 }
  }
}
if ($sessions.Count -eq 0) {
  $result = @{ available = $false; reason = 'no-session' }
} else {
  $result = @{ available = $true; sessions = $sessions }
}
$json = ConvertTo-Json -InputObject $result -Compress -Depth 5
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
