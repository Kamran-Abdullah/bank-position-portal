@echo off
setlocal EnableExtensions
title Bank Position Portal
cd /d "%~dp0"

echo ============================================================
echo    BANK POSITION PORTAL  -  Demo Group of Companies
echo ============================================================
echo.

REM --- 1. check Node.js ---------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js is not installed or not on PATH.
  echo     Install the LTS version from https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo [ok] Node.js %NODEV%

REM --- 2. free port 4201 if a previous copy is still running -------------
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP .*:4201 .*LISTENING"') do (
  echo [..] Stopping a previous copy still using port 4201 ^(PID %%p^)...
  taskkill /f /pid %%p >nul 2>&1
)

REM --- 3. install dependencies on first run ----------------------------
if not exist "node_modules\tesseract.js\package.json" (
  echo.
  echo [..] First run - installing dependencies ^(needs internet, one time only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [X] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
) else (
  echo [ok] Dependencies already installed
)

echo.
echo [..] Starting the portal ...
echo.

REM --- 4. open the browser once the server has had a moment to start --
start "" /b cmd /c "ping -n 5 127.0.0.1 >nul & start "" http://localhost:4201"

echo ------------------------------------------------------------
echo   The portal will open in your browser in a few seconds.
echo   If it does not, open this address manually:
echo.
echo        http://localhost:4201
echo.
echo   Login:  123     Password:  123
echo.
echo   KEEP THIS WINDOW OPEN while you use the portal.
echo   Close this window (or press Ctrl+C) to stop it.
echo ------------------------------------------------------------
echo.

set PORT=4201
node server.js

echo.
echo Portal stopped.
pause
