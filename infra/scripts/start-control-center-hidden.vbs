Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")
scriptPath = filesystem.BuildPath(filesystem.GetParentFolderName(WScript.ScriptFullName), "start-control-center.ps1")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """", 0, False
