@echo off
REM 在 Windows 上打 .exe 安装包。macOS 产不出 exe，需在 Windows 机器运行。
cd /d "%~dp0"

echo [1/2] 安装依赖
call npm install
if errorlevel 1 goto :err
call npm ls electron-builder >nul 2>&1 || call npm install -D electron-builder
if errorlevel 1 goto :err

if not exist "..\workbench\server.py" (
  echo 找不到 ..\workbench\server.py，仓库不完整
  goto :err
)

echo [2/2] 打包 exe
call npx electron-builder --win --x64
if errorlevel 1 goto :err

echo.
echo 完成：dist 目录下的 .exe 安装包
echo 发版不用手动传：push 一个 v 开头的 tag，GitHub Actions 会双平台出包并传 Releases。
goto :eof

:err
echo 打包失败
exit /b 1
