# 讓信令伺服器在登入 Windows 時自動在背景啟動（不需要系統管理員權限）
# 執行：powershell -ExecutionPolicy Bypass -File windows\install-autostart.ps1
# 移除：powershell -ExecutionPolicy Bypass -File windows\install-autostart.ps1 -Remove
param([switch]$Remove)

$TaskName = 'RD Signaling Server'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已移除排程工作「$TaskName」"
    return
}

$node = (Get-Command node -ErrorAction Stop).Source
$serverDir = (Resolve-Path (Join-Path $PSScriptRoot '..\server')).Path
if (-not (Test-Path (Join-Path $serverDir 'node_modules'))) {
    Push-Location $serverDir; npm install --omit=dev; Pop-Location
}
if (-not (Test-Path (Join-Path $serverDir '.env'))) {
    Copy-Item (Join-Path $serverDir '.env.example') (Join-Path $serverDir '.env')
    Write-Host '已建立 server\.env（使用預設值）'
}

$action = New-ScheduledTaskAction -Execute $node -Argument 'src\server.js' -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "已設定：登入後自動啟動信令伺服器（排程工作「$TaskName」），現在也已啟動。"
