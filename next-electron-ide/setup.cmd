@echo off
cd /d E:\agentzero_clone\Agent-Zero-Takneek-main\next-electron-ide
echo [%date% %time%] cleaning node_modules > setup.log
rmdir /s /q node_modules >> setup.log 2>&1
echo [%date% %time%] running npm install >> setup.log
call npm install --no-audit --no-fund >> setup.log 2>&1
echo [%date% %time%] npm install finished with exit code %ERRORLEVEL% >> setup.log
echo SETUP_DONE >> setup.log
