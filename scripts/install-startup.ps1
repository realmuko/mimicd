# Install a Startup-folder shortcut so the mimicd WATCHDOG starts at logon (no admin needed).
#
# 注意：自启的是看门狗，不是引擎本身。
# 引擎只是被看门狗拉起来的子进程 —— 只自启引擎的话，它崩了/卡了还是没人管；
# 看门狗会一直守着，引擎不在就重启它（见 scripts/watchdog.mjs）。
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'mimicd-wechat.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"<repo>\scripts\launch-watchdog.vbs"'
$s.WorkingDirectory = '<repo>'
$s.WindowStyle = 7
$s.Description = 'mimicd watchdog (keeps the WeChat engine alive)'
$s.Save()
Write-Output ("startup shortcut installed: " + $lnk)