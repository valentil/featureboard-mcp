@echo off
REM ============================================================
REM  One-click: validate the FeatureBoard hybrid-RAG embeddings
REM  path (FBMCPF-315). Double-click this file and walk away.
REM  Output lands in validation-logs\ next to this script.
REM ============================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0validate-embeddings.ps1"
echo.
pause
