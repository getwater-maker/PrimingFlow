@echo off
title OmniVoice TTS Backend :9881

echo [OmniVoice] Starting backend (first run: model download takes a few minutes)
echo [OmniVoice] Listening on http://0.0.0.0:9881
echo [OmniVoice] Stop: Ctrl+C

REM Persistent data location (matches start-autorun.bat - same path under any user/SYSTEM account)
set "API_DIR=%~dp0"
set "FLOW_DATA_DIR=%API_DIR%data"
set "FLOW_DICT_PATH=%FLOW_DATA_DIR%\omnivoice-dict.shared.json"

REM API key auth - set to non-empty value to require X-API-Key header (matches start-autorun.bat)
set "FLOW_API_KEY="
if not exist "%FLOW_DATA_DIR%" mkdir "%FLOW_DATA_DIR%" 2>nul
echo [OmniVoice] dict: %FLOW_DICT_PATH%

call conda activate OmniVoice 2>nul
if errorlevel 1 (
    echo [ERROR] conda env 'OmniVoice' not found.
    echo         Run: conda create -n OmniVoice python=3.10 -y
    pause
    exit /b 1
)

python "%API_DIR%api.py" --address 0.0.0.0 --port 9881 --gpu cuda:0

pause
