@echo off
title V720 PC Studio
echo ========================================================
echo   Iniciando V720 PC Studio (Engenharia Reversa REA)
echo ========================================================
echo.
cd /d "%~dp0"
start http://localhost:3000
npm run dev
pause
