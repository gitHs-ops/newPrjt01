@echo off
rem ==== setup.bat : install Python packages for sdgen (once) ====
rem ASCII only on purpose: cmd mis-reads UTF-8 batch files.
cd /d "%~dp0"
python -m pip install --upgrade openpyxl pillow playwright pywin32 || exit /b 1
python -m playwright install chromium || exit /b 1
echo ok
