@echo off
cd /d <repo>
REM NOTE: keep this file pure ASCII. cmd.exe reads .cmd as GBK, so UTF-8 Chinese
REM comments turn into garbage and can break the command line below.
REM
REM --ime-restore must point back to the user's own IME. If omitted, tools/daemon.ts
REM defaults to com.android.adbkeyboard/.AdbIME, so the engine leaves ADBKeyboard as
REM the active IME; its dark "{ON}" status bar covers the bottom of the screen and
REM breaks page detection (2026-11-18).
REM
REM Log file: data\daemon.log. (Was daemon-current.out -- that name got stuck with a
REM leaked file handle and made every restart fail with "file in use".)
"<node>\node.exe" tools\daemon.ts --adb "<dsh>\.tools\platform-tools\adb.exe" --serial <serial> --launch-wechat --ime-restore com.baidu.input_huawei/.ImeService >> "<repo>\data\daemon.log" 2>&1