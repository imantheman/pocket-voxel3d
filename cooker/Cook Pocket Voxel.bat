@echo off
rem Pocket Voxel cooker, Windows front door.
rem
rem   Drag your Red, Blue or Yellow .gb file (or your Yellow, Gold, Silver
rem   or Crystal .gbc file) onto this file.
rem
rem Everything it does is in cooker.py, next to this file, which is plain
rem Python you can open in Notepad. This .bat only finds a Python to run it
rem with. If the PC has none, it offers to fetch the official portable build
rem from python.org into the _work folder here -- nothing gets installed.
setlocal EnableExtensions
cd /d "%~dp0"
title Pocket Voxel cooker

set "PY="
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
  if not errorlevel 1 set "PY=py -3"
)
if defined PY goto :run

python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto :run

if exist "_work\python\python.exe" set "PY=_work\python\python.exe"
if defined PY goto :run

echo.
echo Python is not on this PC, and the cooker is written in Python.
echo It can fetch the official portable build (11 MB) from
echo   https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip
echo into the _work folder next to this file. Nothing gets installed;
echo delete the folder and it is gone.
echo.
set "OK=y"
set /p "OK=Fetch it? [Y/n] "
if /i "%OK%"=="n" goto :end
if /i "%OK%"=="no" goto :end

if not exist "_work" mkdir "_work"
echo Downloading ...
curl -L -o "_work\python.zip" "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"
if errorlevel 1 (
  echo The download failed. Check the internet connection and try again.
  goto :end
)
rem the checksum is pinned here; a different file is refused
certutil -hashfile "_work\python.zip" SHA256 | findstr /i "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3" >nul
if errorlevel 1 (
  echo The downloaded Python does not match its checksum. Not using it.
  del "_work\python.zip"
  goto :end
)
if exist "_work\python" rmdir /s /q "_work\python"
mkdir "_work\python"
tar -xf "_work\python.zip" -C "_work\python"
del "_work\python.zip"
set "PY=_work\python\python.exe"

:run
%PY% cooker.py %*

:end
echo.
pause
