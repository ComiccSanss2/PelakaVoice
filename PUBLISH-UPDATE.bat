@echo off
title PelakaVoice - Pubblica aggiornamento
cd /d "%~dp0"
node scripts/publish-update.js
pause
