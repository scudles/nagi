@echo off
chcp 65001 >nul
title 凪 Nagi
cd /d "%~dp0"

rem 本机全局设了 ELECTRON_RUN_AS_NODE=1，会让 electron 退化成 node，必须先清掉
set ELECTRON_RUN_AS_NODE=

rem 若未构建过，先构建
if not exist "out\main\index.js" (
  echo [凪] 首次启动，正在构建...
  call npm run build
  if errorlevel 1 (
    echo [凪] 构建失败，请检查网络与依赖。
    pause
    exit /b 1
  )
)

echo [凪] 启动桌宠...
start "" "node_modules\electron\dist\electron.exe" .
