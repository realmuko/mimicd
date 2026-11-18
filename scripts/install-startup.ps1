# Install a Startup-folder shortcut so the WeChat engine starts at logon (no admin needed).
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'mimicd-wechat.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"<repo>\scripts\launch-daemon.vbs"'
$s.WorkingDirectory = '<repo>'
$s.WindowStyle = 7
$s.Description = 'WeChat engine (mimicd daemon)'
$s.Save()
Write-Output ("startup shortcut installed: " + $lnk)