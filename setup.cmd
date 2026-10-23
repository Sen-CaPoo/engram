@echo off
rem Engram setup: install missing tools (Node.js, Git, GitHub CLI), sign in to GitHub, then run "engram install".
rem Options: -Label <name> (computer name in Engram), -DryRun (check only, change nothing)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\install\setup.ps1" %*
set ENGRAM_SETUP_EXIT=%ERRORLEVEL%
rem Keep the window open when started by double-click
echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i "%~0" >nul && pause
exit /b %ENGRAM_SETUP_EXIT%
