@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-extension.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation failed. Read the error above.
  pause
)
