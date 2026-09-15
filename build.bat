@echo off
cd /d "%~dp0"
echo ============================================
echo   Answer Book - rebuild answer data
echo   source: answers.txt  -^>  js/answers.js
echo ============================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] python not found in PATH.
  echo         Install Python or run the script manually.
  echo.
  pause
  exit /b 1
)

python "%~dp0tools\build_data.py"
if errorlevel 1 (
  echo.
  echo [ERROR] build failed. See message above.
  echo.
  pause
  exit /b 1
)

echo.
pause
