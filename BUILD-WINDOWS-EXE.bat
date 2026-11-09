@echo off
title PelakaVoice - Build installer
cd /d "%~dp0"
echo Compilazione dell installer in corso...
call npm run build
echo.
echo Fatto: controlla la cartella dist
pause
