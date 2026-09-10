' Starts Splitpage at sign-in with no window of its own.
'
' The Run entry points here rather than at node.exe so that signing in does
' not flash a console window. start.bat --background serves the app and the
' document library in the background, and exits at once if one is already
' running, so a second sign-in on the same machine costs nothing.

Option Explicit
Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
' 0 = hidden, False = do not wait for it to finish.
shell.Run """" & here & "\start.bat"" --background", 0, False
