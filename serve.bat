@echo off
cd /d "%~dp0"
echo ============================================
echo   Answer Book - local preview server
echo   http://127.0.0.1:8765/
echo   Press Ctrl+C to stop.
echo ============================================
echo.
node "%~dp0tools\serve.js" %1
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to start. Is Node.js installed?
  echo.
  pause
)
