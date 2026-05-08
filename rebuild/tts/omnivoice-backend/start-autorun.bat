@echo off
REM OmniVoice autorun batch (Task Scheduler / SYSTEM account safe - ASCII only)
REM - Calls conda env python.exe by absolute path (no conda activate)
REM - Sets HF_HOME to D drive (avoids SYSTEM profile cache)
REM - Logs to .\logs\omnivoice_*.log

setlocal EnableDelayedExpansion

set "CONDA_PYTHON=D:\miniconda3\envs\OmniVoice\python.exe"
set "API_DIR=%~dp0"
set "LOG_DIR=%API_DIR%logs"
set "HF_HOME=D:\huggingface_cache"
set "PORT=9881"
set "GPU=cuda:0"

REM Persistent data location (immune to SYSTEM vs user-account home divergence).
REM Backend folder itself is on D drive, so server data lives next to it.
set "FLOW_DATA_DIR=%API_DIR%data"
set "FLOW_DICT_PATH=%FLOW_DATA_DIR%\omnivoice-dict.shared.json"

REM -- API key authentication (B-option) ----------------------------
REM Set FLOW_API_KEY to a random 32-char string to require X-API-Key header
REM on every request (except /health). Empty value means no auth (trusted LAN).
REM PrimingFlow client must store the same key in TTS server modal.
REM Example: set "FLOW_API_KEY=8f3a9c2d4e1b7a6f5e4d3c2b1a0f9e8d"
set "FLOW_API_KEY=39aa681cf28af8971bb4e67cc63fb94a"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul
if not exist "%HF_HOME%" mkdir "%HF_HOME%" 2>nul
if not exist "%FLOW_DATA_DIR%" mkdir "%FLOW_DATA_DIR%" 2>nul

if not exist "%CONDA_PYTHON%" (
    echo [ERROR] Python not found: %CONDA_PYTHON% > "%LOG_DIR%\omnivoice_error.log"
    exit /b 1
)

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul ^| find "="') do set "DT=%%I"
if "!DT!"=="" set "DT=00000000000000"
set "STAMP=!DT:~0,8!_!DT:~8,4!"
set "LOG_FILE=%LOG_DIR%\omnivoice_!STAMP!.log"

echo [OmniVoice] start at %DATE% %TIME% (port %PORT%, %GPU%) > "%LOG_FILE%"
echo [OmniVoice] python: %CONDA_PYTHON% >> "%LOG_FILE%"
echo [OmniVoice] HF_HOME: %HF_HOME% >> "%LOG_FILE%"
echo [OmniVoice] FLOW_DICT_PATH: %FLOW_DICT_PATH% >> "%LOG_FILE%"
echo [OmniVoice] working dir: %API_DIR% >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

"%CONDA_PYTHON%" "%API_DIR%api.py" --address 0.0.0.0 --port %PORT% --gpu %GPU% >> "%LOG_FILE%" 2>&1

set "RC=!ERRORLEVEL!"
echo. >> "%LOG_FILE%"
echo [OmniVoice] exit at %DATE% %TIME% (code !RC!) >> "%LOG_FILE%"
exit /b !RC!
