' 无窗口拉起微信引擎（mimicd daemon）。
' 用 vbs 是为了不弹黑框；用 WMI 创建是为了让它脱离调用它的 shell，不被一起收掉。
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "<repo>"
sh.Run "cmd /c ""<repo>\scripts\run-daemon.cmd""", 0, False