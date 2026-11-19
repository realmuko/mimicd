# Register the mimicd supervisor as a Scheduled Task (run this once, elevated).
# ASCII only.
$ErrorActionPreference = 'Stop'
$Root = '<repo>'
$TaskName = 'mimicd-supervisor'
$Ps1 = Join-Path $Root 'scripts\supervisor.ps1'

if (-not (Test-Path $Ps1)) { throw "supervisor.ps1 not found: $Ps1" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Ps1 + '"')

$atLogon = New-ScheduledTaskTrigger -AtLogOn
$repeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) `
  -LogonType Interactive -RunLevel Highest

# replace if it already exists
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $repeat) `
  -Settings $settings -Principal $principal -Description 'mimicd wechat engine supervisor (usb/adb recovery + daemon keepalive)' | Out-Null

Write-Output ('registered: ' + $TaskName)

# retire the old node watchdog (it would fight with this task)
$startup = [Environment]::GetFolderPath('Startup')
Get-ChildItem -Path $startup -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
  $shell = New-Object -ComObject WScript.Shell
  $t = $shell.CreateShortcut($_.FullName).TargetPath
  if ($t -match 'watchdog|mimicd') {
    Move-Item -Force $_.FullName ($_.FullName + '.retired')
    Write-Output ('retired startup: ' + $_.Name)
  }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*watchdog.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output ('stopped watchdog pid ' + $_.ProcessId) }

# run once right away so the phone link is recovered now
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ps1
Write-Output 'supervisor ran once'
