@echo off
REM 在 Windows 上打 .exe 安装包（macOS 无法产出 exe，需在 Windows 机器运行本脚本）
REM 前置：安装 Node.js（含 npm），把 workbench 文件夹放到本脚本同级目录

echo [1/5] 安装依赖
call npm install
if errorlevel 1 goto :err
call npm install -D electron-builder
if errorlevel 1 goto :err

echo [2/5] 检查 workbench
if not exist "workbench\server.py" (
  echo 找不到 workbench\server.py，请把 workbench 文件夹放到本脚本同级目录
  goto :err
)

echo [3/5] 检查 Windows 版 runtime
if not exist "workbench\runtime\venv\Scripts\python.exe" (
  echo 缺少 Windows 版运行环境：workbench\runtime\venv\Scripts\python.exe
  echo 请在 Windows 上运行 workbench\install.bat 重新生成本机 runtime
  goto :err
)

echo [4/5] 清理用户数据与 Key
if exist "workbench\console.env" del "workbench\console.env"
if exist "workbench\projects" rmdir /s /q "workbench\projects"
if exist "workbench\.git" rmdir /s /q "workbench\.git"

echo [5/5] 打包 exe
call npx electron-builder --win --x64
if errorlevel 1 goto :err

echo 完成：dist 目录下的 .exe 安装包
goto :eof

:err
echo 打包失败
exit /b 1
