#!/usr/bin/env bash
# 准备打包用的工作台代码：取源码 → 去掉 runtime 和用户数据 → 打补丁。
# 本地打包：默认用 WORKBENCH_SRC 指向的本地目录。
# CI 打包：没有本地目录时，从 WORKBENCH_REPO 的 WORKBENCH_REF 克隆。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$HERE/.stage"
DEST="$STAGE/workbench"

WORKBENCH_SRC="${WORKBENCH_SRC:-$HOME/WorkBuddy/2026-11-16-16-08-27/viral-replica-workbench}"
# TODO fork 建好后改成 open-axio/viral-replica-workbench，并把 REF 钉到具体 commit
WORKBENCH_REPO="${WORKBENCH_REPO:-https://github.com/alyunzhangu/viral-replica-workbench.git}"
WORKBENCH_REF="${WORKBENCH_REF:-main}"

mkdir -p "$STAGE"
[ -e "$DEST" ] && rm -rf "$DEST"

if [ -f "$WORKBENCH_SRC/server.py" ]; then
  echo "[1/3] 用本地源码：$WORKBENCH_SRC"
  mkdir -p "$DEST"
  # 不拷 runtime（2GB）和用户数据
  (cd "$WORKBENCH_SRC" && tar -cf - \
      --exclude=runtime \
      --exclude=projects \
      --exclude=library \
      --exclude=batches \
      --exclude=console.env \
      --exclude=__pycache__ \
      --exclude=.git \
      --exclude='*.log' \
      .) | (cd "$DEST" && tar -xf -)
else
  echo "[1/3] 本地没有源码，改从 $WORKBENCH_REPO ($WORKBENCH_REF) 克隆"
  git clone --depth 1 --branch "$WORKBENCH_REF" "$WORKBENCH_REPO" "$DEST"
  rm -rf "$DEST/.git" "$DEST/runtime" "$DEST/projects" "$DEST/library" "$DEST/batches"
  rm -f "$DEST/console.env"
fi

echo "[2/3] 打补丁"
bash "$HERE/patch-workbench.sh" "$DEST"

echo "[3/3] 校验"
[ -f "$DEST/server.py" ] || { echo "缺 server.py，准备失败"; exit 1; }
[ -d "$DEST/runtime" ] && { echo "runtime 不该出现在包里"; exit 1; }
SIZE="$(du -sh "$DEST" | cut -f1)"
echo "工作台代码就绪：$DEST（$SIZE）"
