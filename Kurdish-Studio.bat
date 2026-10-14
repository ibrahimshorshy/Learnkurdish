@echo off
setlocal
title Leen Kurdish Studio

REM Always run from the folder this file lives in, so double-clicking works
REM regardless of where Explorer thinks the working directory is.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo.
  echo   Get the LTS installer from https://nodejs.org, run it,
  echo   then close this window and double-click Kurdish-Studio.bat again.
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

node setup.mjs

REM Keep the window open if something failed, so the error is readable.
if errorlevel 1 (
  echo.
  echo   Something went wrong. The message above says what.
  pause
)
