@echo off
cd /d "%~dp0"
if not exist .env (echo .env not found - run setup.bat first! & pause & exit /b 1)
if not exist ffmpeg.exe (echo ffmpeg.exe not found - run setup.bat first! & pause & exit /b 1)
if not exist yt-dlp.exe (echo yt-dlp.exe not found - run setup.bat first! & pause & exit /b 1)
if not exist node_modules (echo node_modules not found - run setup.bat first! & pause & exit /b 1)
echo Starting bot (window will close)...
start /b wscript.exe "%~dp0start-hidden.vbs"
exit
