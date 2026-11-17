"""工作台的路径划分：哪些只读、哪些要可写。

打成桌面应用之后，代码装在应用内部（macOS 是 .app/Contents/Resources，只读；
往签名过的 bundle 里写东西会让签名失效），而 Key、项目、素材库和运行时都必须
可写，所以要落在应用外部的数据目录。

    CODE_ROOT    server.py 所在目录。只读：console/、web/、engine/、tools/
    DATA_DIR     可写：console.env、projects/、library/、batches/
    RUNTIME_DIR  可写：Python、FFmpeg、Whisper 模型，约 2GB，首次启动时装

本模块刻意不 import 包内其它模块——config 与 gateway 之间有循环导入的历史，
放在这里谁都能安全引用。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

CODE_ROOT = Path(__file__).resolve().parents[1]

#: Electron 外壳启动 server.py 前会设置它。命令行直接跑也可以手动指定。
DATA_DIR_ENV = "VIRALREPLICA_DATA_DIR"

#: 旧布局的痕迹：这些东西曾经就放在 server.py 同级。
_LEGACY_MARKERS = ("console.env", "runtime", "projects", "library", "batches")


def _platform_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "ViralReplica"
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local"
        return Path(base) / "ViralReplica"
    base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / "ViralReplica"


def _writable(path: Path) -> bool:
    try:
        return path.is_dir() and os.access(path, os.W_OK)
    except OSError:
        return False


def resolve_data_dir() -> Path:
    """按优先级定数据目录。

    1. 环境变量指定 —— 桌面应用走这条，目录由用户在首次启动向导里选
    2. 同级已有旧布局 —— 老用户和开发机，保持原样不动
    3. 代码目录可写 —— 从源码直接跑（git clone 之后 ./start.command）
    4. 平台默认位置 —— 代码装在只读位置时的归宿
    """
    override = os.environ.get(DATA_DIR_ENV)
    if override and override.strip():
        return Path(override).expanduser()
    if any((CODE_ROOT / name).exists() for name in _LEGACY_MARKERS):
        return CODE_ROOT
    if _writable(CODE_ROOT):
        return CODE_ROOT
    return _platform_data_dir()


DATA_DIR = resolve_data_dir()
RUNTIME_DIR = DATA_DIR / "runtime"

#: 数据目录和代码目录是不是同一个。旧布局和源码直跑时为真。
INLINE_LAYOUT = DATA_DIR == CODE_ROOT


def describe() -> dict:
    """给设置页和排错用。"""
    return {
        "code_root": str(CODE_ROOT),
        "data_dir": str(DATA_DIR),
        "runtime_dir": str(RUNTIME_DIR),
        "inline_layout": INLINE_LAYOUT,
        "from_env": bool(os.environ.get(DATA_DIR_ENV)),
    }
