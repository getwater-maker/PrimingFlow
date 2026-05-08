# OmniVoice 자동기동 — Windows 작업 스케줄러 등록 스크립트
#
# 사용법 (GPU 머신에서 관리자 PowerShell 로 실행):
#   cd D:\PrimingFlow\rebuild\tts\omnivoice-backend
#   PowerShell -ExecutionPolicy Bypass -File .\register-task.ps1
#
# 등록 후:
#   Start-ScheduledTask -TaskName "OmniVoice_Backend"     # 즉시 실행 테스트
#   Get-ScheduledTask -TaskName "OmniVoice_Backend" | Get-ScheduledTaskInfo
#   Stop-ScheduledTask  -TaskName "OmniVoice_Backend"     # 중지
#   Unregister-ScheduledTask -TaskName "OmniVoice_Backend" -Confirm:$false  # 삭제

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$TaskName  = "OmniVoice_Backend"
$BatchPath = Join-Path $PSScriptRoot "start-autorun.bat"

if (-not (Test-Path $BatchPath)) {
    Write-Error "start-autorun.bat 을 찾을 수 없습니다: $BatchPath"
    exit 1
}

Write-Host "[OmniVoice] 작업 스케줄러 등록: $TaskName"
Write-Host "[OmniVoice] 실행 대상: $BatchPath"

# 기존 동일 이름 작업 제거 (재등록 허용)
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[OmniVoice] 기존 작업 제거 중..."
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
    -Description "OmniVoice TTS FastAPI 서버 (PrimingFlow 백엔드, 포트 9881)" | Out-Null

Write-Host "[OmniVoice] 등록 완료." -ForegroundColor Green
Write-Host ""
Write-Host "다음 단계:"
Write-Host "  1) 즉시 실행 테스트:"
Write-Host "     Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "  2) 1~2분 후 헬스체크:"
Write-Host "     Invoke-WebRequest http://localhost:9881/health"
Write-Host ""
Write-Host "  3) 로그 확인:"
Write-Host "     Get-ChildItem '$PSScriptRoot\logs' | Sort LastWriteTime -Desc | Select -First 1"
