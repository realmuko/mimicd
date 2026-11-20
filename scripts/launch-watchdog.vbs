' Launch the mimicd watchdog with no console window.
' Keep this file pure ASCII: wscript/cscript read .vbs as ANSI, so UTF-8
' Chinese comments get mojibake and break the script (2026-11-18).
' The watchdog is what keeps the WeChat engine alive, so autostart points here,
' not at the engine itself.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "node """ & root & "\scripts\watchdog.mjs""", 0, False