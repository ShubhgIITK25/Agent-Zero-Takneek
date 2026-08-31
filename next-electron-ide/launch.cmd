@echo off
cd /d E:\agentzero_clone\Agent-Zero-Takneek-main\next-electron-ide
echo [%date% %time%] launching electron > launch.log
call npx electron . >> launch.log 2>&1
echo [%date% %time%] electron exited with code %ERRORLEVEL% >> launch.log
echo LAUNCH_EXITED >> launch.log
