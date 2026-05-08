@echo off
REM OmniVoice backend restart - double-click to run
REM The .ps1 will request admin permission via UAC popup

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-omnivoice.ps1"

REM In case ps1 exited abnormally
if errorlevel 1 (
    echo.
    echo [OmniVoice] Script did not exit cleanly.
    pause
)
