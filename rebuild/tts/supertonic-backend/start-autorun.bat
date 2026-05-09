@echo off
REM Supertonic-3 autorun batch (Task Scheduler / SYSTEM account safe - ASCII only)
REM - Calls conda env python.exe by absolute path (no conda activate)
REM - CPU-only, no GPU required
REM - Logs to .\logs\supertonic_*.log

setlocal EnableDelayedExpansion

set "CONDA_PYTHON=D:\miniconda3\envs\Supertonic\python.exe"
set "API_DIR=%~dp0"
set "LOG_DIR=%API_DIR%logs"
set "HF_HOME=D:\huggingface_cache"
set "PORT=9882"

REM -- API key authentication (B-option) ----------------------------
REM Optional: same FLOW_API_KEY pattern as OmniVoice for consistency.
REM Empty = no auth (trusted local).
set "FLOW_API_KEY="
set "FLOW_SUPERTONIC_PORT=%PORT%"

if not exist "%LOG_DIR%"  mkdir "%LOG_DIR%"  2>nul
if not exist "%HF_HOME%"  mkdir "%HF_HOME%"  2>nul

if not exist "%CONDA_PYTHON%" (
    echo [ERROR] Python not found: %CONDA_PYTHON% > "%LOG_DIR%\supertonic_error.log"
    exit /b 1
)

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul ^| find "="') do set "DT=%%I"
if "!DT!"=="" set "DT=00000000000000"
set "STAMP=!DT:~0,8!_!DT:~8,4!"
set "LOG_FILE=%LOG_DIR%\supertonic_!STAMP!.log"

echo [Supertonic] start at %DATE% %TIME% (port %PORT%, CPU only) > "%LOG_FILE%"
echo [Supertonic] python: %CONDA_PYTHON% >> "%LOG_FILE%"
echo [Supertonic] HF_HOME: %HF_HOME% >> "%LOG_FILE%"
echo [Supertonic] working dir: %API_DIR% >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

"%CONDA_PYTHON%" "%API_DIR%api.py" --host 0.0.0.0 --port %PORT% >> "%LOG_FILE%" 2>&1

set "RC=!ERRORLEVEL!"
echo. >> "%LOG_FILE%"
echo [Supertonic] exit at %DATE% %TIME% (code !RC!) >> "%LOG_FILE%"
exit /b !RC!
