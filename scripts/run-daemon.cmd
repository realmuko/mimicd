@echo off
REM NOTE: keep this file pure ASCII. cmd.exe reads .cmd as GBK, so UTF-8 Chinese
REM comments turn into garbage and can break the command line below.
REM
REM Machine-local values live in data\device.cmd (gitignored):
REM   set MIMICD_ADB=<path to adb.exe>     (optional; default: adb from PATH)
REM   set MIMICD_SERIAL=<device serial>    (required)
REM   set MIMICD_IME=<restore IME>         (optional)
REM
REM --ime-restore must point back to the user's own IME. If omitted, tools/daemon.ts
REM defaults to com.android.adbkeyboard/.AdbIME, so the engine leaves ADBKeyboard as
REM the active IME; its dark "{ON}" status bar covers the bottom of the screen and
REM breaks page detection (2026-11-18).
REM
REM Log file: data\daemon.log. (Was daemon-current.out -- that name got stuck with a
REM leaked file handle and made every restart fail with "file in use".)
REM Use node from PATH: do not hardcode an absolute node.exe here, the two machines
REM (desktop and laptop) keep node in different places. Both are 24.x.
setlocal
cd /d "%~dp0.."
if exist "%~dp0..\data\device.cmd" call "%~dp0..\data\device.cmd"
if "%MIMICD_ADB%"=="" set "MIMICD_ADB=adb"
if "%MIMICD_IME%"=="" set "MIMICD_IME=com.baidu.input_huawei/.ImeService"
if "%MIMICD_SERIAL%"=="" (
  echo [run-daemon] missing MIMICD_SERIAL - create data\device.cmd with: set MIMICD_SERIAL=...
  exit /b 1
)
node tools\daemon.ts --adb "%MIMICD_ADB%" --serial %MIMICD_SERIAL% --launch-wechat --ime-restore "%MIMICD_IME%" >> "%~dp0..\data\daemon.log" 2>&1