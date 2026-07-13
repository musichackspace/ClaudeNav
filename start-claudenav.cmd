@echo off
REM ClaudeNav one-click launcher for Windows.
REM Double-click this file to start the server and open the dashboard.
REM Keep the window open while you use ClaudeNav; close it to stop the server.
setlocal
cd /d "%~dp0"

REM If ClaudeNav is already serving, just open the dashboard and exit.
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',4317)}catch{exit 1}finally{$c.Close()}; exit 0"
if not errorlevel 1 (
  echo ClaudeNav is already running - opening the dashboard...
  start "" http://127.0.0.1:4317
  exit /b 0
)

REM Locate Node. cmd inherits the user PATH, so `node` usually works; fall back
REM to the common install dirs (mirrors resolve_node in the Tauri wrapper).
REM (single-line if + goto avoids parenthesized blocks, which the literal
REM parens in %ProgramFiles(x86)% would otherwise break.)
set "NODE=node"
where node >nul 2>&1 && goto :have_node
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe" & goto :have_node
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe" & goto :have_node
if exist "%APPDATA%\npm\node.exe" set "NODE=%APPDATA%\npm\node.exe" & goto :have_node
echo.
echo Node.js was not found. Install it from https://nodejs.org then run this again.
echo.
pause
exit /b 1
:have_node

REM Open the dashboard as soon as the server binds the port (waits up to ~15s).
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',4317);$c.Close();Start-Process 'http://127.0.0.1:4317';break}catch{Start-Sleep -Milliseconds 500}}"

echo Starting ClaudeNav on http://127.0.0.1:4317
echo Keep this window open. Close it to stop the server.
echo.
"%NODE%" server.js
