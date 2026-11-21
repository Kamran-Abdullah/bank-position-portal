@echo off
setlocal EnableExtensions
title Bank Position - Install Outlook Agent
cd /d "%~dp0"

echo ============================================================
echo    OUTLOOK AGENT  -  automatic statement pick-up
echo ============================================================
echo.
echo This sets up a background task that, every day from 8:00 AM to 11:00 AM,
echo checks your Outlook inbox every 20 minutes for bank-statement e-mails
echo and saves their attachments into the "Inbox Drop" folder. The portal then
echo reads them and posts the balances.
echo.
echo It only READS Outlook. It never moves, deletes or replies to mail.
echo Mailbox and rules are in:  outlook-agent\config.json
echo.

set "PS1=%~dp0outlook-agent\Fetch-BankStatements.ps1"
if not exist "%PS1%" ( echo [X] Cannot find %PS1% & pause & exit /b 1 )
set "CMDLINE=powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%PS1%\""

rem Daily at 08:00, repeat every 20 minutes for 3 hours + 1 minute, so the last run is at 11:00.
schtasks /create /tn "BankPositionOutlookAgent" /sc daily /st 08:00 /ri 20 /du 0003:01 /tr "%CMDLINE%" /f >nul
if errorlevel 1 ( echo [X] Could not create the 8-11 AM task. & pause & exit /b 1 )
rem Windows creates the task with 'do not run on battery', no catch-up and no wake by default: that made runs get refused
rem (error 0x800710E0) whenever the PC was unplugged or asleep at 8 AM. Switch those off / on so the task runs reliably.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1); Set-ScheduledTask -TaskName 'BankPositionOutlookAgent' -Settings $s | Out-Null" >nul 2>&1
if errorlevel 1 ( echo [!] The task was created, but its power settings could not be adjusted - runs may be skipped on battery. )

echo [ok] Tasks installed.
echo.
echo Doing a first check of your Outlook now ^(last 7 days^) ...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
echo.
echo Done. Start the portal ^(Start Bank Position Portal.cmd^) to process the files.
echo To stop the agent later, run "Remove Outlook Agent.cmd".
echo.
pause
