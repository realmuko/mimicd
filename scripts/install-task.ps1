$ErrorActionPreference = 'Stop'
try {
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"<repo>\scripts\launch-daemon.vbs"' -WorkingDirectory "<repo>"
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "mimicd-wechat" -Action $action -Trigger $trigger -Settings $settings -Description "微信引擎（mimicd daemon）：登录时无窗口拉起" | Out-Null
  Write-Output "created"
} catch {
  Write-Output ("create failed: " + $_.Exception.Message)
}
try {
  Get-ScheduledTask -TaskName "mimicd-wechat" | Select-Object TaskName, State | Format-List
} catch { }