@echo off
cd /d "%~dp0"
if not exist node_modules call npm install --silent
start "" /min wscript.exe "%~dp0run-hidden.vbs"
