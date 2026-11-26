# Makes Windows keep a small crash dump (a few MB) whenever a phone's emulator crashes, in data\crash-dumps.
# Handset reads it and writes where the crash happened to data\logs\crashes.log.
# Needs administrator rights once (Windows only reads this setting machine-wide). Undo: add -Off.
param([switch]$Off)

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Run this from a PowerShell window opened with "Run as administrator".'
  exit 1
}

$key = 'HKLM:\Software\Microsoft\Windows\Windows Error Reporting\LocalDumps\qemu-system-x86_64-headless.exe'
if ($Off) {
  Remove-Item $key -ErrorAction SilentlyContinue
  Write-Host 'Crash dumps for the emulator are off.'
  exit 0
}

$dir = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\crash-dumps'
New-Item -ItemType Directory -Force $dir | Out-Null
New-Item -Force $key | Out-Null
New-ItemProperty $key -Name DumpFolder -PropertyType ExpandString -Value $dir -Force | Out-Null
New-ItemProperty $key -Name DumpType -PropertyType DWord -Value 1 -Force | Out-Null   # small dump: threads, stacks, libraries
New-ItemProperty $key -Name DumpCount -PropertyType DWord -Value 10 -Force | Out-Null # keeps the last 10
Write-Host "Crash dumps for the emulator go to $dir"
