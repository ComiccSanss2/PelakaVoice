@echo off
title PelakaVoice - Server online
cd /d "%~dp0"
echo Avvio del server PelakaVoice e del tunnel Cloudflare...
echo.
node server/online-server.js
pause
