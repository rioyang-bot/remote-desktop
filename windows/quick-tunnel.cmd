@echo off
rem 臨時測試用：不需要 Cloudflare 帳號，會產生一個 https://xxxx.trycloudflare.com 網址
rem 每次執行網址都會不同，正式使用請改用具名 Tunnel（見 README）
set CF="%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not exist %CF% set CF=cloudflared
%CF% tunnel --no-autoupdate --url http://localhost:8080
