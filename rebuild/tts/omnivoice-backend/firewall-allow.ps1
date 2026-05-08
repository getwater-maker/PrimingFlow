# OmniVoice 방화벽 인바운드 규칙 (LAN 내 다른 PC 에서 9881 접속 허용)
#
# 사용법 (GPU 머신에서 관리자 PowerShell 로 1회 실행):
#   PowerShell -ExecutionPolicy Bypass -File .\firewall-allow.ps1
#
# 사설망(Private)에만 노출 — Public 프로파일은 일부러 제외.
# 공유기 내부 IP 대역에서만 접근 가능하게 유지하기 위함.

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$RuleName = "OmniVoice TTS (PrimingFlow)"
$Port = 9881

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[OmniVoice] 기존 방화벽 규칙 제거 중..."
    Remove-NetFirewallRule -DisplayName $RuleName
}

New-NetFirewallRule `
    -DisplayName $RuleName `
    -Description "OmniVoice FastAPI 서버 LAN 인바운드 (PrimingFlow TTS 백엔드)" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Private `
    -Enabled True | Out-Null

Write-Host "[OmniVoice] 방화벽 인바운드 규칙 등록 완료." -ForegroundColor Green
Write-Host "  이름:    $RuleName"
Write-Host "  포트:    TCP $Port"
Write-Host "  프로파일: Private (사설망 한정)"
Write-Host ""
Write-Host "현재 네트워크가 'Private' 으로 설정되어 있어야 적용됩니다:"
Write-Host "  Get-NetConnectionProfile"
Write-Host "(NetworkCategory 가 'Public' 이면 'Private' 으로 변경 필요)"
