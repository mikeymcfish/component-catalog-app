@echo off
setlocal

set "APP_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\launch-component-catalog.ps1" -Lan
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if %EXIT_CODE% NEQ 0 (
  echo Component Catalog local-network access did not start. Review the message above.
) else (
  echo Keep the Component Catalog LAN Server window open while using the phone.
)
pause
exit /b %EXIT_CODE%
