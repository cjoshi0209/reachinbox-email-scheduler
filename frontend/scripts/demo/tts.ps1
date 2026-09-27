# Usage: powershell -File frontend/scripts/demo/tts.ps1 -InFile frontend/scripts/demo/narration.json -OutDir .infra/demo/audio [-Voice Mark]
# Windows OneCore neural-ish TTS (no cloud service). Durations -> .infra/demo/durations.json (see README).
# lines.json: [{ "id": "s01", "text": "..." }, ...]  ->  dir/s01.wav ...
param([string]$InFile, [string]$OutDir, [string]$Voice = 'Mark')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -match $Voice } | Select-Object -First 1
if (-not $v) { throw "voice $Voice not found" }
$synth.Voice = $v
$synth.Options.SpeakingRate = 1.02
$synth.Options.AudioPitch = 1.0

New-Item -ItemType Directory -Force $OutDir | Out-Null
$lines = Get-Content $InFile -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($l in $lines) {
  $stream = Await ($synth.SynthesizeTextToStreamAsync($l.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $size = [uint32]$stream.Size
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [System.IO.File]::WriteAllBytes((Join-Path $OutDir "$($l.id).wav"), $bytes)
  Write-Output "$($l.id) ok"
}
