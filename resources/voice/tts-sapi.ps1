# resources/voice/tts-sapi.ps1
# Windows SAPI text-to-speech bridge (offline, no API key, no network).
#
# ENCODING CONTRACT -- KEEP THIS FILE PURE ASCII (no BOM, no non-ASCII bytes):
#   Windows PowerShell 5.1 decodes a .ps1 using the system code page when the file has
#   no BOM. On a Chinese Windows that means GBK, so any non-ASCII byte could be decoded
#   wrongly and silently corrupt the script (this exact bug bit monitor-sampler.ps1 once).
#   Nothing here needs non-ASCII: the text to speak is read from a UTF-8 file, and all
#   output goes to UTF-8 files. test/voice.test.js locks this invariant.
#
# Usage:
#   -Mode voices                                -> list installed voices as JSON
#   -Mode speak -TextFile a.txt -OutFile a.wav  -> synthesize to WAV

param(
  [string]$Mode = 'speak',
  [string]$TextFile = '',
  [string]$OutFile = '',
  [string]$ResultFile = '',
  [string]$Voice = '',
  [int]$Rate = 0,
  [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  if ($ResultFile) {
    [System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Output $json
}

try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

  if ($Mode -eq 'voices') {
    $list = @()
    foreach ($v in $synth.GetInstalledVoices()) {
      $i = $v.VoiceInfo
      $list += [pscustomobject]@{
        name    = $i.Name
        culture = $i.Culture.Name
        gender  = $i.Gender.ToString()
        age     = $i.Age.ToString()
      }
    }
    $synth.Dispose()
    Write-Result @{ ok = $true; voices = $list }
    exit 0
  }

  if (-not $TextFile -or -not (Test-Path -LiteralPath $TextFile)) {
    $synth.Dispose(); Write-Result @{ ok = $false; error = 'text file missing' }; exit 1
  }
  if (-not $OutFile) {
    $synth.Dispose(); Write-Result @{ ok = $false; error = 'out file missing' }; exit 1
  }

  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  if (-not $text -or $text.Trim().Length -eq 0) {
    $synth.Dispose(); Write-Result @{ ok = $false; error = 'empty text' }; exit 1
  }

  if ($Voice) { try { $synth.SelectVoice($Voice) } catch { } }

  if ($Rate -lt -10) { $Rate = -10 }
  if ($Rate -gt 10) { $Rate = 10 }
  if ($Volume -lt 0) { $Volume = 0 }
  if ($Volume -gt 100) { $Volume = 100 }
  $synth.Rate = $Rate
  $synth.Volume = $Volume

  $usedVoice = $synth.Voice.VoiceInfo.Name
  $synth.SetOutputToWaveFile($OutFile)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  $synth.Dispose()

  $len = (Get-Item -LiteralPath $OutFile).Length
  Write-Result @{ ok = $true; bytes = $len; voice = $usedVoice }
  exit 0
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
