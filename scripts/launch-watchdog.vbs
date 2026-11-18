' Launch the mimicd watchdog with no console window.
' Keep this file pure ASCII: wscript/cscript read .vbs as ANSI, so UTF-8
' Chinese comments get mojibake and break the script (2026-11-18).
' Paths have no spaces, so no quoting is needed.
' The watchdog is what keeps the WeChat engine alive, so autostart points here,
' not at the engine itself.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "<repo>"
sh.Run "<node>\node.exe <repo>\scripts\watchdog.mjs", 0, False