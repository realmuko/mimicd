' Launch the WeChat engine (mimicd daemon) with no console window.
' vbs is only here to avoid a flashing black box; Run(..., 0) also detaches it
' from the shell that started it.
' Keep this file pure ASCII: wscript/cscript read .vbs as ANSI.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "cmd /c """ & root & "\scripts\run-daemon.cmd""", 0, False