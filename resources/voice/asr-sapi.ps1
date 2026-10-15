# resources/voice/asr-sapi.ps1
# Windows SAPI speech-recognition bridge (offline, no API key, no network).
#
# ENCODING CONTRACT -- KEEP THIS FILE PURE ASCII (no BOM, no non-ASCII bytes).
#   See resources/voice/tts-sapi.ps1 for the full explanation. Recognized text is
#   written to a UTF-8 JSON file, never through this script's own source encoding.
#
# Usage:
#   -ListRecognizers out.json                 -> list installed recognizers
#   -WavFile a.wav -ResultFile out.json       -> transcribe a 16-bit PCM WAV
#
# Note on DictationGrammar: SAPI may split one recording into several phrases
# (it cuts at pauses). We loop Recognize() until it returns nothing and join the
# parts -- otherwise a sentence with a pause would come back truncated.

param(
  [string]$WavFile = '',
  [string]$ResultFile = '',
  [string]$Culture = 'zh-CN',
  [string]$ListRecognizers = ''
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

  if ($ListRecognizers) {
    $list = @()
    foreach ($r in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) {
      $list += [pscustomobject]@{
        id          = $r.Id
        culture     = $r.Culture.Name
        description = $r.Description
      }
    }
    $ResultFile = $ListRecognizers
    Write-Result @{ ok = $true; recognizers = $list }
    exit 0
  }

  if (-not $WavFile -or -not (Test-Path -LiteralPath $WavFile)) {
    Write-Result @{ ok = $false; error = 'wav file missing' }; exit 1
  }

  $engine = $null
  foreach ($r in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) {
    if ($r.Culture.Name -eq $Culture) {
      $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($r)
      break
    }
  }
  if (-not $engine) {
    Write-Result @{ ok = $false; error = 'recognizer not installed'; culture = $Culture }
    exit 1
  }

  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToWaveFile($WavFile)

  $parts = @()
  $conf = 0.0
  $guard = 0
  while ($guard -lt 30) {
    $guard++
    # At the END of a wave file SAPI does NOT return $null -- it THROWS
    # "No audio input was supplied to this recognizer". So each Recognize()
    # MUST be guarded on its own: if the throw escapes to the top-level try,
    # every phrase already recognized is discarded and the whole transcription
    # is reported as a failure (bug found 2026-10-16, reproduced 3/3).
    try {
      $res = $engine.Recognize()
    } catch {
      $res = $null
      break
    }
    if (-not $res) { break }
    if ($res.Text) {
      $parts += $res.Text
      if ($conf -eq 0.0) { $conf = $res.Confidence }
    }
  }
  $engine.Dispose()

  $text = ''
  if ($parts.Count -gt 0) { $text = ($parts -join '') }
  Write-Result @{ ok = $true; text = $text; confidence = $conf; phrases = $parts.Count }
  exit 0
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
