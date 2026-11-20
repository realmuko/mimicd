' Launch the elevated mimicd supervisor with NO console window.
' Why: the scheduled task used to call powershell.exe directly with
' -WindowStyle Hidden. On this machine (task RunLevel=Highest, interactive)
' that still creates a visible "Administrator: powershell.exe" console and it
' grabs the foreground for a moment every 2 minutes (measured 2026-11-19
' 22:33:39 and 22:35:39). wscript + Run(..., 0) hides it properly.
' Keep this file pure ASCII: wscript reads .vbs as ANSI.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\scripts\supervisor.ps1""", 0, False