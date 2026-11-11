@echo off
cd /d "%~dp0"
echo Installing multiplayer server dependencies...
npm install
if errorlevel 1 (
  echo.
  echo Installation failed. Check Node.js and internet connection.
  pause
  exit /b 1
)
echo.
echo Installation complete. Run START_INTERNET.bat to host an internet game.
pause
