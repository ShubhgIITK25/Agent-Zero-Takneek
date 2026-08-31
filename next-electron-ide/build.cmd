@echo off
cd /d E:\agentzero_clone\Agent-Zero-Takneek-main\next-electron-ide
echo [%date% %time%] starting build > build.log
call npm run build >> build.log 2>&1
echo [%date% %time%] build finished with exit code %ERRORLEVEL% >> build.log
echo BUILD_DONE >> build.log
