@echo off
cd /d <repo>
REM --ime-restore 必须显式指回用户自己的输入法。
REM 不传的话 tools/daemon.ts 里默认值是 com.android.adbkeyboard/.AdbIME，
REM 引擎打完字就把输入法还成 ADBKeyboard，屏幕最底下常驻一条深灰
REM 「ADB Keyboard {ON}」状态条（实测 luma 83），会盖掉页面判定的底部亮边，
REM 让列表页/会话页判不出来（2026-11-18 排查）。
"<node>\node.exe" tools\daemon.ts --adb "<dsh>\.tools\platform-tools\adb.exe" --serial <serial> --launch-wechat --ime-restore com.baidu.input_huawei/.ImeService >> "<repo>\data\daemon-current.out" 2>&1