@echo off
REM Double-click me. Runs the bench script over tokens.txt sitting beside it.
REM One line and nothing else, so nobody has to remember the powershell incantation.
powershell -ExecutionPolicy Bypass -File "%~dp0lock-bench.ps1" "%~dp0..\tokens.txt"
pause
