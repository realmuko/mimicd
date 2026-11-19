# 手机回来后一键恢复：等设备 → 重新部署注入器 → 起引擎
#
#   powershell -ExecutionPolicy Bypass -File <repo>\tools\recover.ps1
#
# 只做三件事，不碰 adb server 的启动/停止（那属于运维，不该脚本乱动）。

$ErrorActionPreference = "SilentlyContinue"
$adb = "<dsh>/.tools/platform-tools/adb.exe"
$root = "<repo>"
Set-Location $root

Write-Host "等待手机（adb get-state = device）……"
$last = ""
while ($true) {
    $state = (& $adb get-state 2>$null | Select-Object -First 1)
    if ($state -match "device") { break }
    if ($state -ne $last) { Write-Host ("  当前状态: " + ($(if ($state) { $state } else { "未连接" }))); $last = $state }
    Start-Sleep -Seconds 5
}
Write-Host "手机在线，重新部署注入器……"
& node tools/inject/deploy.ts --adb $adb

Write-Host "启动引擎……"
$running = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "daemon\.ts" }
if ($running) {
    Write-Host "  引擎已经在跑（PID $($running.ProcessId)），不重复启动"
} else {
    Start-Process -FilePath "node" `
        -ArgumentList @("tools/daemon.ts", "--adb", $adb, "--interval", "20", "--allow-pending-inject") `
        -WorkingDirectory $root -WindowStyle Hidden
    Write-Host "  已启动（日志: $root\data\daemon.out）"
}

Start-Sleep -Seconds 8
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:65480/health" -TimeoutSec 5
    Write-Host ("引擎: online=" + $health.device.online + " page=" + $health.device.page + " paused=" + $health.paused)
} catch {
    Write-Host "  引擎健康检查没通，看 data\daemon.out"
}