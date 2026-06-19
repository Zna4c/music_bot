' Start bot in background without CMD window
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
botDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = botDir
 
' Створюємо папку logs якщо немає
If Not fso.FolderExists(botDir & "\logs") Then
    fso.CreateFolder(botDir & "\logs")
End If
 
' Запускаємо бота у фоні
WshShell.Run "cmd /c node src\index.js >> logs\bot.log 2>&1", 0, False
 
' Чекаємо 3 секунди поки бот запуститься
WScript.Sleep 3000
 
' Відкриваємо браузер автоматично
WshShell.Run "http://localhost:3000", 1, False
 