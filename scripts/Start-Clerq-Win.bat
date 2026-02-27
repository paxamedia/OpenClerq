@echo off
REM Double-click to start Clerq: gateway in background, then desktop app.
REM Place this script in clerq\scripts\ and run from Explorer.
REM Requires: Node, pnpm.

cd /d "%~dp0\.."

start /B cmd /c "pnpm gateway"
timeout /t 2 /nobreak >nul

set "APP=apps\desktop\src-tauri\target\release\clerq-desktop.exe"
if exist "%APP%" (
  start "" "%APP%"
  echo Opened Clerq app.
) else (
  echo No built app. Run: cd apps\desktop ^&^& pnpm exec tauri build
  cd apps\desktop && pnpm exec tauri dev
)
echo Gateway is running in the background.
