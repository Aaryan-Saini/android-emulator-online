# Windows only: stops Microsoft Defender from scanning every file the Android emulator reads and writes (the
# phone snapshot, its disk images, temporary files). Phones then start faster and their first minute is smoother.
# Only emulator files are excluded. Needs administrator rights once. Undo: add -Off.
param([switch]$Off)

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Run this from a PowerShell window opened with "Run as administrator".'
  exit 1
}

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$paths = @(
  (Join-Path $env:USERPROFILE '.android\avd'),   # emulator profiles and the clean phone snapshot
  (Join-Path $env:TEMP 'AndroidEmulator'),       # each running phone's temporary disk files
  (Join-Path $sdk 'emulator')                    # the emulator itself
)
$processes = @('qemu-system-x86_64-headless.exe', 'qemu-system-x86_64.exe', 'emulator.exe')

if ($Off) {
  Remove-MpPreference -ExclusionPath $paths -ExclusionProcess $processes
  Write-Host 'Defender scans the emulator again.'
  exit 0
}
Add-MpPreference -ExclusionPath $paths -ExclusionProcess $processes
Write-Host 'Defender no longer scans these emulator folders and processes:'
$paths + $processes | ForEach-Object { Write-Host "  $_" }
