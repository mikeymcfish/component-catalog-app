@echo off
setlocal

set "APP_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\launch-component-catalog.ps1"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Component Catalog did not start. Review the message above.
  pause
  exit /b 1
)

exit /b 0
