@echo off
setlocal

set "APP_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\launch-phone-access.ps1"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Phone access did not start. Review the message above.
  pause
  exit /b 1
)

exit /b 0
