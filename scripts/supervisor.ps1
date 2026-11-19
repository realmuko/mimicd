# mimicd supervisor (runs elevated via Scheduled Task, every 2 minutes).
# ASCII only: keep it readable by Windows PowerShell 5.1 in any codepage.
#
# Layers it checks:
#   1) USB/adb link  -> if the phone is not "device": restart adb server, then
#      disable/enable the USB composite device (a software replug; needs admin).
#   2) engine health -> GET /health; if down or lastTick stale: kill the pid on
#      65480 and start the daemon (only when the phone is actually reachable).
#   3) heartbeat     -> data\supervisor.heartbeat, so a second task can notice
#      when THIS supervisor stops running.

$ErrorActionPreference = 'Continue'
$Root   = '<repo>'
$Data   = Join-Path $Root 'data'
$Log    = Join-Path $Data 'supervisor.log'
$Hb     = Join-Path $Data 'supervisor.heartbeat'
$Node   = '<node>\node.exe'
$Adb    = '<dsh>\.tools\platform-tools\adb.exe'
$Serial = '<serial>'
$Port   = 65480
$DaemonLog = Join-Path $Data 'daemon.log'
$ImeRestore = 'com.baidu.input_huawei/.ImeService'

New-Item -ItemType Directory -Force -Path $Data | Out-Null

function Log([string]$msg) {
  $line = ('{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), $msg)
  try { Add-Content -Path $Log -Value $line -Encoding UTF8 } catch {}
}

# rotate: keep the log small
try {
  if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 4MB)) {
    Move-Item -Force $Log ($Log + '.1')
  }
} catch {}

function Set-Heartbeat([string]$state) {
  try {
    ('{0}|{1}' -f (Get-Date).ToUniversalTime().ToString('o'), $state) | Set-Content -Path $Hb -Encoding UTF8
  } catch {}
}

function Get-AdbState {
  try {
    $out = & $Adb devices 2>$null
    foreach ($line in $out) {
      if ($line -match ('^' + [regex]::Escape($Serial) + '\s+(\S+)')) { return $matches[1] }
    }
  } catch {}
  return 'missing'
}

function Restart-AdbServer {
  # Kill EVERY adb process, not just "kill-server" on the default port.
  # 2026-11-19: a stray `adb -P 5038` server kept the WinUSB handle claimed, so the
  # 5037 server got "Access Denied" and the phone looked disconnected for hours.
  Log 'adb: killing all adb processes and restarting a single server'
  try {
    Get-Process -Name adb -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  } catch {}
  Start-Sleep -Milliseconds 1200
  try { & $Adb start-server 2>$null | Out-Null } catch {}
  Start-Sleep -Seconds 2
}

function Replug-Usb {
  # disable/enable the phone's USB composite device = a software replug.
  # Only works when this script runs elevated (the scheduled task does).
  $dev = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like ('USB\VID_12D1&PID_107E\*' + $Serial) } |
    Select-Object -First 1
  if (-not $dev) {
    $dev = Get-PnpDevice -ErrorAction SilentlyContinue |
      Where-Object { $_.InstanceId -like ('USB\VID_12D1&PID_107E\*' + $Serial) } |
      Select-Object -First 1
  }
  if (-not $dev) { Log 'usb: composite device not found (cable/port?)'; return $false }
  Log ('usb: replug ' + $dev.InstanceId)
  try { Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false -ErrorAction Stop } catch { Log ('usb: disable failed: ' + $_.Exception.Message) }
  Start-Sleep -Milliseconds 1200
  try { Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false -ErrorAction Stop } catch { Log ('usb: enable failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 4
  return $true
}

function Ensure-Device {
  $state = Get-AdbState
  if ($state -eq 'device') { return $true }
  Log ('adb: state=' + $state)
  Restart-AdbServer
  $state = Get-AdbState
  if ($state -eq 'device') { Log 'adb: recovered by server restart'; return $true }

  # Only try the USB replug when Windows still enumerates the ADB interface.
  # If the interface is gone entirely, disabling/enabling the composite device just
  # makes the PnP state worse (2026-11-19) - that case needs a physical replug.
  $adbIface = Get-PnpDevice -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like '*VID_12D1*MI_02*' } | Select-Object -First 1
  if (-not $adbIface) {
    Log 'adb: ADB interface not enumerated at all - physical replug needed; no usb action'
    Log ('adb: NOT reachable (state=' + $state + ') - waiting for the phone; daemon not started')
    return $false
  }

  # one replug attempt per run (and don't spam: at most every 5 minutes)
  $stampFile = Join-Path $Data 'last-usb-replug.txt'
  $last = 0
  try { $last = [int64](Get-Content $stampFile -ErrorAction SilentlyContinue) } catch { $last = 0 }
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (($nowMs - $last) -gt 300000) {
    try { $nowMs | Set-Content $stampFile } catch {}
    if (Replug-Usb) {
      Restart-AdbServer
      $state = Get-AdbState
      if ($state -eq 'device') { Log 'adb: recovered by usb replug'; return $true }
    }
  } else {
    Log 'adb: still not ready, replug skipped (cooldown)'
  }
  Log ('adb: NOT reachable (state=' + $state + ') - waiting for the phone; daemon not started')
  return $false
}

function Get-EngineHealth {
  try {
    return Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 6
  } catch {
    return $null
  }
}

function PidOnPort {
  try {
    $line = netstat -ano | Select-String -Pattern (':' + $Port + '\s+.*LISTENING') | Select-Object -First 1
    if (-not $line) { return 0 }
    $parts = ($line.ToString().Trim() -split '\s+')
    return [int]$parts[-1]
  } catch { return 0 }
}

function Start-Daemon {
  $pid = PidOnPort
  if ($pid -gt 0) {
    Log ('engine: killing pid ' + $pid)
    try { taskkill /F /PID $pid 2>$null | Out-Null } catch {}
    Start-Sleep -Seconds 2
  }
  if ((PidOnPort) -gt 0) { Log 'engine: port still busy, skip start'; return }
  $args = @(
    (Join-Path $Root 'tools\daemon.ts'),
    '--adb', $Adb, '--serial', $Serial,
    '--launch-wechat', '--ime-restore', $ImeRestore
  )
  try {
    Start-Process -FilePath $Node -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden `
      -RedirectStandardOutput $DaemonLog -RedirectStandardError ($DaemonLog + '.err')
    Log 'engine: daemon started'
  } catch {
    Log ('engine: start failed: ' + $_.Exception.Message)
  }
}

function Ensure-Injector {
  # The engine also needs the on-phone injector (tcp 7801). After a reboot/adb drop
  # it can be gone while adb is fine; redeploy/restart it before starting the daemon.
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', 7801, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { throw 'timeout' }
    $client.EndConnect($iar)
    $client.Close()
    return $true
  } catch {
    try { $client.Close() } catch {}
  }
  Log 'injector: not responding on 127.0.0.1:7801 - redeploying'
  try {
    $p = Start-Process -FilePath $Node -ArgumentList @((Join-Path $Root 'tools\inject\deploy.ts'), '--adb', $Adb, '--serial', $Serial, '--restart') -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    $p | Wait-Process -Timeout 90 -ErrorAction SilentlyContinue
  } catch { Log ('injector: deploy failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 2
  $c2 = New-Object System.Net.Sockets.TcpClient
  try {
    $iar2 = $c2.BeginConnect('127.0.0.1', 7801, $null, $null)
    if (-not $iar2.AsyncWaitHandle.WaitOne(1500)) { throw 'timeout' }
    $c2.EndConnect($iar2)
    $c2.Close()
    Log 'injector: recovered'
    return $true
  } catch {
    try { $c2.Close() } catch {}
    Log 'injector: still not responding'
    return $false
  }
}

# ---- main ----
$deviceOk = Ensure-Device
if (-not $deviceOk) { Set-Heartbeat 'device-offline'; exit 0 }
Ensure-Injector | Out-Null

$h = Get-EngineHealth
if ($null -eq $h) {
  Log 'engine: health unreachable'
  Start-Daemon
  Set-Heartbeat 'engine-restarted'
  exit 0
}

$lastAt = 0
try { $lastAt = [int64]$h.lastTick.at } catch { $lastAt = 0 }
$stale = 0
if ($lastAt -gt 0) { $stale = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $lastAt }
if ($stale -gt 240000) {
  Log ('engine: lastTick stale ' + [int]$stale + 'ms')
  Start-Daemon
  Set-Heartbeat 'engine-stale-restarted'
} else {
  Set-Heartbeat 'ok'
}
