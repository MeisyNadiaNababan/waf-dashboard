@echo off
TITLE WAF Dashboard
cd /d "%~dp0backend"

python --version >nul 2>&1
IF ERRORLEVEL 1 (
  echo [ERROR] Install Python 3.10+ dulu
  pause & exit /b 1
)

IF NOT EXIST venv (
  echo Membuat virtual environment...
  python -m venv venv
)
call venv\Scripts\activate.bat

echo Install dependencies...
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
 
echo.
echo ============================================================
echo  Server: http://localhost:5000
echo  CTRL+C untuk stop.
echo ============================================================
start "" http://localhost:5000
python app.py
pause