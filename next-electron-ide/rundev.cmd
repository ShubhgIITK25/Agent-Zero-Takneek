@echo off
cd /d E:\agentzero_clone\Agent-Zero-Takneek-main\next-electron-ide
echo [%date% %time%] starting npm run dev > dev.log
call npm run dev >> dev.log 2>&1
echo [%date% %time%] npm run dev exited with code %ERRORLEVEL% >> dev.log
echo DEV_EXITED >> dev.log
