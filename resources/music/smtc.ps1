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
$session = $manager.GetCurrentSession()
if ($null -eq $session) {
  $result = @{ available = $false; reason = 'no-session' }
} else {
  $props = Wait-Operation ($session.TryGetMediaPropertiesAsync()) $propsType
  $status = $session.GetPlaybackInfo().PlaybackStatus.ToString()
  $result = @{
    available = $true
    app = [string]$session.SourceAppUserModelId
    title = [string]$props.Title
    artist = [string]$props.Artist
    playbackStatus = [string]$status
  }
}
$json = ConvertTo-Json -InputObject $result -Compress -Depth 3
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
