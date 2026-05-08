# OmniVoice backend force-restart script
# Usage: double-click restart-omnivoice.bat (or run this file directly)

# ---- Self-elevation (re-launch as admin if not already) ----
$current = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $current.IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Host "[OmniVoice] Requesting admin permission..." -ForegroundColor Yellow
    Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"" -Verb RunAs
    exit
}

# ---- Now running as administrator ----
$Host.UI.RawUI.WindowTitle = "OmniVoice Backend Restart"
Write-Host ""
Write-Host "===== OmniVoice Backend Restart =====" -ForegroundColor Cyan
Write-Host ""
Write-Host "[OmniVoice] Killing process on port 9881..." -ForegroundColor Yellow

try {
    $conns = Get-NetTCPConnection -LocalPort 9881 -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($conn in $conns) {
            $procId = $conn.OwningProcess
            if ($procId -gt 0) {
                try {
                    Stop-Process -Id $procId -Force -ErrorAction Stop
                    Write-Host ("[OmniVoice] PID " + $procId + " killed.") -ForegroundColor Green
                } catch {
                    Write-Host ("[OmniVoice] PID " + $procId + " kill FAILED: " + $_.Exception.Message) -ForegroundColor Red
                }
            }
        }
    } else {
        Write-Host "[OmniVoice] No process on port 9881 (already stopped)" -ForegroundColor Gray
    }
} catch {
    Write-Host ("[OmniVoice] Error: " + $_.Exception.Message) -ForegroundColor Red
}

Start-Sleep -Seconds 2

Write-Host ""
Write-Host "===== Next Steps =====" -ForegroundColor Cyan
Write-Host "  1. Close PrimingFlow completely (X button)" -ForegroundColor White
Write-Host "  2. Start PrimingFlow again" -ForegroundColor White
Write-Host "  3. Wait 1-2 minutes for OmniVoice to load" -ForegroundColor White
Write-Host "  4. Preset modal -> Server Share -> Refresh -> Green dot" -ForegroundColor White
Write-Host ""
Read-Host "Press Enter to close this window"
