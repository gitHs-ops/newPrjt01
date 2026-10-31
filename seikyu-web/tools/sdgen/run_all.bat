@echo off
rem ==== run_all.bat : regenerate the screen design workbook (seikyu-web) ====
rem ASCII only on purpose: cmd mis-reads UTF-8 batch files.
rem Usage: run_all.bat              ... all screens in screens.json
rem        run_all.bat SC-PUR-01    ... one screen
rem Needs: local verification server (SDGEN_BASE, default http://127.0.0.1:8098) and
rem        SDGEN_PASSWORD or SDGEN_PASSWORD_FILE for the local user (SDGEN_USER, default doc-admin).
setlocal
chcp 65001 > nul
set "PYTHONUTF8=1"
cd /d "%~dp0"
if "%SDGEN_PASSWORD%%SDGEN_PASSWORD_FILE%"=="" (
  echo [stop] set SDGEN_PASSWORD or SDGEN_PASSWORD_FILE first
  exit /b 1
)
echo [1/5] capture screens
python capture.py %1 || goto :fail
echo [2/5] report images
python report_img.py || goto :fail
echo [3/5] build workbook
python build.py %1 || goto :fail
echo [4/5] arrows
python finish.py || goto :fail
echo [5/5] compare with the latest design workbook
python compare.py %1 || goto :fail
echo done: see work\build
exit /b 0
:fail
echo [error] stopped
exit /b 1
