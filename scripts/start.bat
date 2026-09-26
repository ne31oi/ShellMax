@echo off
rem ShellMax: starts the backend (which starts the standalone ComfyUI engine) and opens the browser.
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

if not exist "comfy\ComfyUI_windows_portable\python_embeded\python.exe" (
  echo Движок ещё не установлен. Запускаю установку...
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install_comfy.ps1" || goto :fail
)

if not exist "frontend\dist\index.html" (
  echo Собираю интерфейс...
  pushd frontend
  call npm install --no-audit --no-fund || goto :fail
  call npm run build || goto :fail
  popd
)

set SHELLMAX_OPEN_BROWSER=1
cd backend
uv run python -m app.main
goto :eof

:fail
echo.
echo Не удалось запустить ShellMax. Смотрите сообщения выше.
pause
