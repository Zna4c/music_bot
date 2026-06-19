@echo off
cd /d "%~dp0"
title Discord Music Bot - Setup
color 0A

echo.
echo ================================================
echo   Discord Music Bot - Автоматичне налаштування
echo ================================================
echo.

:: ── Крок 1: Перевірка Node.js ─────────────────────────────────────────────────
echo [1/3] Перевіряємо Node.js...
node --version >nul 2>&1
if %errorlevel% == 0 (
    for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v вже встановлено
    goto :check_npm
)

echo [!!] Node.js не знайдено. Завантажуємо та встановлюємо...
echo.

:: Визначаємо архітектуру (x64 або x86)
reg query "HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0" /v Identifier | find "x86" >nul 2>&1
if %errorlevel% == 0 (
    set NODE_ARCH=x86
    set NODE_URL=https://nodejs.org/dist/v20.19.0/node-v20.19.0-x86.msi
    set NODE_FILE=node-installer.msi
) else (
    set NODE_ARCH=x64
    set NODE_URL=https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi
    set NODE_FILE=node-installer.msi
)

echo Завантажуємо Node.js v20 (%NODE_ARCH%)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "& {$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_FILE%' -UseBasicParsing}"
if not exist %NODE_FILE% (
    echo [!!] Не вдалося завантажити Node.js!
    echo      Встанови вручну: https://nodejs.org/
    pause
    exit /b 1
)

echo Встановлюємо Node.js (може зайняти хвилину)...
msiexec /i %NODE_FILE% /qn /norestart
del /f /q %NODE_FILE% 2>nul

:: Оновлюємо PATH щоб node був доступний без перезапуску
set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm"

:: Чекаємо поки node стане доступним
timeout /t 3 /nobreak >nul

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!!] Node.js встановлено, але потрібен перезапуск командного рядка.
    echo      Закрий це вікно, відкрий заново і запусти setup.bat ще раз.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v встановлено успішно!

:check_npm
:: ── Крок 2: Перевірка npm ─────────────────────────────────────────────────────
echo.
echo [2/3] Перевіряємо npm...
npm --version >nul 2>&1
if %errorlevel% == 0 (
    for /f "tokens=*" %%v in ('npm --version') do echo [OK] npm %%v
) else (
    echo [!!] npm не знайдено! Перевстанови Node.js з https://nodejs.org/
    pause
    exit /b 1
)

:: ── Крок 3: Запуск setup.js ───────────────────────────────────────────────────
echo.
echo [3/3] Запускаємо головний setup (завантажить ffmpeg, yt-dlp, пакети)...
echo.
node setup.js
if %errorlevel% neq 0 (
    echo.
    echo [!!] setup.js завершився з помилкою!
    pause
    exit /b 1
)

echo.
echo ================================================
echo   Готово! Тепер запусти start.bat
echo ================================================
echo.
pause
