# Supertonic-3 autorun registration (Windows Task Scheduler)
# ASCII only — PowerShell 5.1 reads .ps1 as CP949 on Korean Windows;
# Korean inside Write-Host strings becomes "?" and breaks the parser.
#
# Usage (run as Administrator):
#   cd D:\PrimingFlow\rebuild\tts\supertonic-backend
#   PowerShell -ExecutionPolicy Bypass -File .\register-task.ps1
#
# After registration:
#   Start-ScheduledTask        -TaskName 'Supertonic_Backend'   # immediate test
#   Get-ScheduledTask          -TaskName 'Supertonic_Backend' | Get-ScheduledTaskInfo
#   Stop-ScheduledTask         -TaskName 'Supertonic_Backend'   # stop
#   Unregister-ScheduledTask   -TaskName 'Supertonic_Backend' -Confirm:$false  # remove

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$TaskName  = "Supertonic_Backend"
$BatchPath = Join-Path $PSScriptRoot "start-autorun.bat"

if (-not (Test-Path $BatchPath)) {
    Write-Error "start-autorun.bat not found: $BatchPath"
    exit 1
}

Write-Host "[Supertonic] Registering scheduled task: $TaskName"
Write-Host "[Supertonic] Target script: $BatchPath"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[Supertonic] Removing existing task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute $BatchPath `
    -WorkingDirectory $PSScriptRoot

$trigger = New-ScheduledTaskTrigger -AtStartup

$principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Supertonic-3 TTS FastAPI server (PrimingFlow auxiliary backend, CPU, port 9882)" | Out-Null

Write-Host "[Supertonic] Registration complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1) Start the task immediately:"
Write-Host "     Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "  2) After 1-2 min (first run downloads ~99M model), health-check:"
Write-Host "     Invoke-WebRequest http://localhost:9882/health -UseBasicParsing"
Write-Host ""
Write-Host "  3) View latest log:"
Write-Host "     Get-ChildItem '$PSScriptRoot\logs' | Sort LastWriteTime -Desc | Select -First 1"
