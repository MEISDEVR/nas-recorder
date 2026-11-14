@echo off
chcp 65001 >nul
title NAS Recorder (local)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 没找到 Node.js，请先安装 LTS 版本：https://nodejs.org
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 echo [i] 未安装 ffmpeg：能正常录制和播放，只是不会自动生成封面和修正时长（可选：winget install ffmpeg）

if not defined DATA_DIR set "DATA_DIR=%~dp0recordings"
set "HTTP_PORT=8080"
echo.
echo  录像保存到：%DATA_DIR%
echo  浏览器地址：http://localhost:8080   （本机用 localhost 不需要 HTTPS）
echo  关闭此窗口即停止服务
echo.
start "" http://localhost:8080
node server.js
pause
