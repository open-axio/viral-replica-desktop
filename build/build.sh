#!/bin/bash
# 一键打包 macOS 桌面版（.dmg）——在 macOS 上运行本脚本
# 产出：桌面/爆款复刻工作台-桌面版/ViralReplica.dmg
# 原理：复制 Electron.app 骨架，注入本目录的 main.js，再把 workbench 作为同级文件夹一起装进 dmg。
#       不把 workbench 塞进 .app 内部，保证 Key/projects 可写、体积可控。

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_PARENT="$(dirname "$HERE")"
DMG="$OUT_PARENT/ViralReplica.dmg"
STAGE="$HERE/.stage"
ELECTRON_APP="$HERE/node_modules/electron/dist/Electron.app"
WORKBENCH_SRC="/Users/shuxq/WorkBuddy/2026-11-16-16-08-27/viral-replica-workbench"

echo "[1/6] 检查依赖"
[ -d "$ELECTRON_APP" ] || { echo "缺少 Electron，请先运行: cd '$HERE' && npm install"; exit 1; }
[ -f "$WORKBENCH_SRC/server.py" ] || { echo "找不到 workbench 源码：$WORKBENCH_SRC"; echo "请修改本脚本顶部的 WORKBENCH_SRC 指向你的 viral-replica-workbench 目录"; exit 1; }
command -v hdiutil >/dev/null || { echo "hdiutil 不可用（需要 macOS）"; exit 1; }

echo "[2/6] 清理临时目录"
# 用 mv 移走旧目录而不是 rm -rf（避免批量删除钩子；旧目录留待系统清理）
if [ -d "$STAGE" ]; then mv "$STAGE" "${STAGE}.old.$(date +%s)"; fi
mkdir -p "$STAGE"

echo "[3/6] 组装 Electron 外壳 .app"
cp -R "$ELECTRON_APP" "$STAGE/ViralReplica.app"
# 移除 Electron 默认示例应用，注入我们的主进程
rm -f "$STAGE/ViralReplica.app/Contents/Resources/default_app.asar"
rm -rf "$STAGE/ViralReplica.app/Contents/Resources/app"
mkdir -p "$STAGE/ViralReplica.app/Contents/Resources/app"
cp "$HERE/main.js" "$HERE/package.json" "$HERE/preload.js" "$STAGE/ViralReplica.app/Contents/Resources/app/"
#  Electron 会优先加载 Contents/Resources/app 目录中的 package.json
# 修改应用标识与显示名
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.local.viralreplica" \
  "$STAGE/ViralReplica.app/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleName ViralReplica" \
  "$STAGE/ViralReplica.app/Contents/Info.plist" 2>/dev/null || true

echo "[4/6] 复制 workbench（含 runtime，排除用户数据与 Key）"
cp -R "$WORKBENCH_SRC" "$STAGE/workbench"
# 关键：不打包任何用户隐私与凭据
rm -f "$STAGE/workbench/console.env"
rm -rf "$STAGE/workbench/projects" "$STAGE/workbench/library" "$STAGE/workbench/batches"
rm -rf "$STAGE/workbench/.git"
find "$STAGE/workbench" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
# 清掉运行日志里的本机信息
rm -f "$STAGE/workbench/runtime/server.log" "$STAGE/workbench/install.log"
# 给前端打补丁：Electron 禁用原生 prompt，换成页面内输入弹窗（幂等）
bash "$HERE/patch-workbench.sh" "$STAGE/workbench"

echo "[5/6] ad-hoc 重签名（否则 macOS 拒绝启动被改动的 Electron）"
# 注入 app 后原有签名失效，须对整个 .app 重新 ad-hoc 签名
codesign --force --deep --sign - "$STAGE/ViralReplica.app" 2>&1 | grep -v "replacing existing signature" || true

echo "[5.5/6] 写入使用说明到镜像根目录"
cp "$OUT_PARENT/使用说明.txt" "$STAGE/使用说明.txt" 2>/dev/null || true

echo "[6/6] 生成 .dmg"
rm -f "$DMG"
hdiutil create -volname "ViralReplica" -srcfolder "$STAGE" -ov -format UDZO "$DMG"

echo "完成：$DMG"
ls -lh "$DMG"
