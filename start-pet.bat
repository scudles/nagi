@echo off
chcp 65001 >nul
title Nagi
cd /d "%~dp0"

rem This machine sets ELECTRON_RUN_AS_NODE=1 globally, which makes electron
rem behave as plain node. Clear it before launching.
set ELECTRON_RUN_AS_NODE=

rem Build first if never built. NOTE: keep this file ASCII-only -- cmd.exe
rem mis-parses non-ASCII bytes under the default console codepage and the
rem script breaks apart into bogus commands.
if not exist "out\main\index.js" (
  echo [Nagi] first run, building...
  call npm run build
  if errorlevel 1 (
    echo [Nagi] build failed. Check network and dependencies.
    pause
    exit /b 1
  )
)

echo [Nagi] launching desktop pet...
start "" "node_modules\electron\dist\electron.exe" .
