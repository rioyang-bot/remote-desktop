@echo off
rem 啟動信令伺服器（設定讀取 server\.env）
cd /d "%~dp0..\server"
if not exist node_modules call npm install --omit=dev
node src\server.js
