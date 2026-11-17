#!/usr/bin/env bash
# macOS 双击即可打包。
cd "$(dirname "$0")"
set -euo pipefail
echo "=== 爆款复刻工作台 · 本地打包（macOS）==="
command -v node >/dev/null || { echo "没装 Node.js，先去 nodejs.org 装一个"; read -n 1 -s -r -p "按任意键关闭"; exit 1; }
[ -f ../workbench/server.py ] || { echo "找不到 ../workbench/server.py，仓库不完整"; read -n 1 -s -r -p "按任意键关闭"; exit 1; }
echo "[1/2] 装依赖"
npm install
npm ls electron-builder >/dev/null 2>&1 || npm install -D electron-builder
echo "[2/2] 打包"
npx electron-builder --mac
echo
echo "打好了："
ls -lh dist/*.dmg 2>/dev/null || true
echo
echo "发版不用手动传：push 一个 v 开头的 tag，GitHub Actions 会双平台出包并传 Releases。"
read -n 1 -s -r -p "按任意键关闭"
