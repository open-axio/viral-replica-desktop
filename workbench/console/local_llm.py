"""电脑体检 + 本机大模型（Ollama 跑千问）。

- hardware()：读显卡 / 显存 / 内存，判断这台电脑能用哪些本地功能。
- Ollama 是独立的免费软件（ollama.com），装好后在 127.0.0.1:11434 提供服务。这里只检查它在不在、
  帮用户下载推荐档位的千问、并把它登记成一个推理渠道「本机」（channel=ollama）。
- 本机模型免费，但比云端慢、效果差一截：适合写脚本、改台词这类纯文字的步骤；读片子能跑但慢。
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request

from . import config

OLLAMA_URL = "http://127.0.0.1:11434"
OLLAMA_DOWNLOAD = "https://ollama.com/download"

#: 推荐档位（都是 Ollama 官方库里的千问 3.5，原生能看图）。gb：下载大小；need：建议显存/统一内存
MODELS = [
    {"id": "qwen3.5:9b", "name": "千问 Qwen3.5 9B", "size": "约 6.6 GB", "gb": 6.6, "need_vram": 8, "need_mac": 16,
     "desc": "8GB 显存的显卡或 16GB 内存的苹果电脑能跑。能看图，写脚本、改台词够用。"},
    {"id": "qwen3.5:4b", "name": "千问 Qwen3.5 4B", "size": "约 3–4 GB", "gb": 3.5, "need_vram": 4, "need_mac": 8,
     "desc": "更小更快，效果再差一些。显卡一般或者只有 CPU 的电脑选它。"},
]
MODEL_IDS = {m["id"] for m in MODELS}

_lock = threading.Lock()
_pull: dict = {}          # {model, state: running|done|failed|cancelled, completed, total, error, status}
_cancel = threading.Event()


# ---------- 体检 ----------

def _run(cmd: list[str], timeout: float = 5) -> str:
    try:
        flags = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW：Windows 上不闪黑框
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=flags)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _ram_gb() -> float:
    try:
        if os.name == "nt":
            import ctypes

            class MEM(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            m = MEM(); m.dwLength = ctypes.sizeof(MEM)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.ullTotalPhys / 1024 ** 3
        if platform.system() == "Darwin":
            return int(_run(["sysctl", "-n", "hw.memsize"]).strip() or 0) / 1024 ** 3
        with open("/proc/meminfo", encoding="utf-8") as fh:
            kb = int(re.search(r"MemTotal:\s+(\d+)", fh.read()).group(1))
        return kb / 1024 ** 2
    except Exception:
        return 0.0


def _nvidia() -> list[dict]:
    exe = shutil.which("nvidia-smi") or (r"C:\Windows\System32\nvidia-smi.exe" if os.name == "nt" else "")
    if not exe or not os.path.exists(exe):
        return []
    out = _run([exe, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    gpus = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2 and parts[1].replace(".", "").isdigit():
            gpus.append({"name": parts[0], "vram_gb": round(float(parts[1]) / 1024, 1)})
    return gpus


def hardware() -> dict:
    system = platform.system()
    apple = system == "Darwin" and platform.machine() == "arm64"
    gpus = [] if system == "Darwin" else _nvidia()
    ram = round(_ram_gb(), 1)
    best = max(gpus, key=lambda g: g["vram_gb"]) if gpus else None
    return {"system": {"Windows": "Windows", "Darwin": "macOS"}.get(system, system),
            "apple_silicon": apple, "ram_gb": ram, "gpu": best,
            "cpu": platform.machine()[:60]}   # platform.processor() 在 Linux/macOS 上会起 uname 子进程，这里用不到型号


def recommend(hw: dict) -> dict:
    """按硬件给出：推荐哪个本机模型、本机生视频行不行。"""
    vram = (hw.get("gpu") or {}).get("vram_gb") or 0
    ram = hw.get("ram_gb") or 0
    if hw.get("apple_silicon"):
        pick = "qwen3.5:9b" if ram >= 16 else "qwen3.5:4b" if ram >= 8 else None
        speed = "能跑，比云端慢" if ram >= 16 else "能跑，比较慢"
    elif vram >= 8:
        pick, speed = "qwen3.5:9b", "能跑，比云端慢"
    elif vram >= 4 or ram >= 16:
        pick, speed = "qwen3.5:4b", "能跑，比较慢" if vram >= 4 else "只能用 CPU 跑，很慢"
    else:
        pick, speed = None, "这台电脑内存和显卡都偏小，不建议跑本机模型"
    video_ok = vram >= 16
    return {
        "model": pick, "speed": speed,
        "video": ("显卡够用（还在规划中）" if video_ok else
                  "需要 16GB 以上显存的 NVIDIA 显卡，这台电脑不够。生成一段 5 秒视频也要好几分钟，用云端更划算"),
    }


# ---------- Ollama ----------

def _opener():
    # 本机地址不走系统代理（有的电脑设了全局代理，会把 127.0.0.1 也转出去）
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _get(path: str, timeout: float = 2) -> dict | None:
    try:
        with _opener().open(OLLAMA_URL + path, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except (OSError, ValueError, urllib.error.URLError):
        return None


def ollama_status() -> dict:
    version = _get("/api/version")
    if version is None:
        return {"running": False, "installed": bool(shutil.which("ollama")), "models": []}
    tags = _get("/api/tags") or {}
    models = [{"id": m.get("name") or m.get("model"), "gb": round((m.get("size") or 0) / 1e9, 1)} for m in tags.get("models") or []]
    return {"running": True, "installed": True, "version": version.get("version"), "models": models}


def status() -> dict:
    hw = hardware()
    st = ollama_status()
    have = {m["id"] for m in st["models"]}
    current = config.get("OLLAMA_MODEL")
    with _lock:
        pull = dict(_pull)
    return {
        "hardware": hw, "recommend": recommend(hw), "ollama": st, "download_url": OLLAMA_DOWNLOAD,
        "models": [{**m, "installed": m["id"] in have, "current": m["id"] == current} for m in MODELS],
        "current": current, "pull": pull,
    }


def _pull_worker(model: str) -> None:
    req = urllib.request.Request(OLLAMA_URL + "/api/pull", data=json.dumps({"model": model, "stream": True}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with _opener().open(req, timeout=60) as resp:
            for raw in resp:
                if _cancel.is_set():
                    with _lock:
                        _pull.update(state="cancelled")
                    return
                try:
                    ev = json.loads(raw.decode("utf-8") or "{}")
                except ValueError:
                    continue
                if ev.get("error"):
                    raise RuntimeError(ev["error"])
                with _lock:
                    if ev.get("total"):
                        _pull.update(completed=ev.get("completed") or 0, total=ev["total"])
                    _pull["status"] = ev.get("status") or _pull.get("status")
                if ev.get("status") == "success":
                    break
        with _lock:
            _pull.update(state="done")
    except Exception as exc:  # 网络断了、磁盘满了……
        with _lock:
            _pull.update(state="failed", error=str(exc)[:300])


def pull(model: str) -> dict:
    if model not in MODEL_IDS:
        raise ValueError("不认识这个模型")
    if not ollama_status()["running"]:
        raise ValueError("Ollama 还没启动：先安装 Ollama 并打开它，再回来点下载")
    with _lock:
        if _pull.get("state") == "running":
            raise ValueError("已经在下载了，等它下完")
        _cancel.clear()
        _pull.clear()
        _pull.update(model=model, state="running", completed=0, total=0, started=time.time())
    threading.Thread(target=_pull_worker, args=(model,), name="ollama-pull", daemon=True).start()
    return status()


def cancel() -> dict:
    _cancel.set()
    return status()


def use(model: str, scope: str = "text") -> dict:
    """把本机模型登记成推理渠道。scope=text：只用于写脚本、改台词（推荐）；all：读片子也用它。"""
    if model not in MODEL_IDS and model not in {m["id"] for m in ollama_status()["models"]}:
        raise ValueError("这个模型还没下载")
    updates = {"OLLAMA_MODEL": model, "ROUTE_SCRIPT": "ollama"}
    if scope == "all":
        updates["ROUTE_ANALYSIS"] = "ollama"
    config.save(updates)
    return status()
