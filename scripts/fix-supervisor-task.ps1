# Swap the mimicd-supervisor task action to the hidden VBS launcher.
# Runs elevated through <repo>\data\run-hidden-elev.vbs (no UAC dialog on this box).
# Logs to <repo>\data\fix-supervisor.log
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $root 'data\fix-supervisor.log'
function W([string]$m) { $m | Add-Content -Path $log -Encoding UTF8 }
Set-Content -Path $log -Value ('=== ' + (Get-Date).ToString('o')) -Encoding UTF8
try {
  $t = Get-ScheduledTask -TaskName 'mimicd-supervisor'
  $old = ($t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' ; '
  W ('old: ' + $old)
  $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + (Join-Path $root 'scripts\launch-supervisor-hidden.vbs') + '"')
  Set-ScheduledTask -TaskName 'mimicd-supervisor' -Action $act | Out-Null
  $t2 = Get-ScheduledTask -TaskName 'mimicd-supervisor'
  $new = ($t2.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' ; '
  W ('new: ' + $new)
  W ('runlevel: ' + $t2.Principal.RunLevel + '  logontype: ' + $t2.Principal.LogonType + '  state: ' + $t2.State)
  W 'OK'
} catch {
  W ('FAIL: ' + $_.Exception.Message)
}