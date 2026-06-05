@echo off
title Delta Robot Operation Station

echo =========================================
echo   DELTA ROBOT OPERATION STATION
echo =========================================
echo.

cd /d "%~dp0"

REM Change these before exposing the station to the internet.
set "SESSION_SECRET=delta_robot_change_this_secret"
set "ADMIN_PASSWORD=admin123"
set "GUEST_PASSWORD=guest123"
set "OPERATOR_LOCK_TIMEOUT_MS=60000"

echo [1/3] Starting Vision Service...
start "Vision Service" cmd /k "cd /d %~dp0vision_service && D:\anaconda\envs\yolo_311\python.exe app.py"

timeout /t 3 /nobreak > nul

echo [2/3] Starting Web Backend...
start "Web Backend" cmd /k "cd /d %~dp0web_backend && node server.js"

timeout /t 2 /nobreak > nul

echo [3/3] Starting Cloudflare Tunnel...
if exist "%~dp0cloudflared\cloudflared.exe" (
    start "Public Tunnel" cmd /k ""%~dp0cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:3000"
) else (
    echo cloudflared\cloudflared.exe not found. Public tunnel skipped.
)

timeout /t 2 /nobreak > nul

echo Opening dashboard...
start http://127.0.0.1:3000

echo.
echo Done.
echo Public URL se hien trong cua so Public Tunnel.
echo Neu muon tat he thong, hay dong cac cua so Vision Service, Web Backend va Public Tunnel.
pause
