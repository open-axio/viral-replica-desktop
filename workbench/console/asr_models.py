"""识别台词的模型：在设置里查看、下载、切换（和首次安装向导的档位一致）。

下载在子进程里跑（faster-whisper 首次加载即下载到 runtime/models/huggingface），不阻塞服务；
连不上 Hugging Face 时自动改用国内镜像并记住。进度按缓存目录大小估算。
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import config, local_models

HF_MIRROR = "https://hf-mirror.com"

#: 档位：和 build/setup.html 的 TIERS 保持一致，另加「最高精度」
TIERS = [
    {"id": "base", "name": "轻量", "size": "约 150 MB", "bytes": 145e6,
     "desc": "口播清楚、没什么背景音乐的探店视频够用。机器老、硬盘紧的选这个。"},
    {"id": "small", "name": "标准", "size": "约 500 MB", "bytes": 484e6, "tag": "推荐",
     "desc": "日常带货和探店视频都够，普通语速的普通话基本不会错。"},
    {"id": "medium", "name": "高精度", "size": "约 1.5 GB", "bytes": 1.53e9,
     "desc": "语速快、有方言口音、背景音乐压过人声的片子更稳，但识别慢一些。"},
    {"id": "large-v3", "name": "最高精度", "size": "约 3 GB", "bytes": 3.09e9,
     "desc": "最准，也最慢。电脑内存 16GB 以上、经常拆难听清的片子再选。"},
]
TIER_IDS = {t["id"] for t in TIERS}

_lock = threading.Lock()
_jobs: dict[str, dict] = {}     # tier → {state: running|failed|done, started, error, proc}


def _cache_dir(tier: str) -> Path:
    return local_models.HF_HUB / f"models--Systran--faster-whisper-{tier}"


def _dir_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                pass
    return total


def installed(tier: str) -> bool:
    return local_models._whisper(tier).get("status") == "ok"


def status() -> dict:
    current = config.get("ASR_MODEL") or "medium"
    rows = []
    with _lock:
        jobs = {k: dict(v) for k, v in _jobs.items()}
    for t in TIERS:
        job = jobs.get(t["id"]) or {}
        row = {k: v for k, v in t.items() if k != "bytes"}
        row.update(installed=installed(t["id"]), current=t["id"] == current, state=job.get("state"),
                   error=job.get("error"))
        if job.get("state") == "running":
            row["progress"] = min(0.99, _dir_bytes(_cache_dir(t["id"])) / t["bytes"])
        rows.append(row)
    return {"current": current, "tiers": rows}


def _download(tier: str) -> None:
    env = {**os.environ, "PYTHONUTF8": "1"}
    code = ("from faster_whisper import WhisperModel; "
            f"WhisperModel({tier!r}, device='cpu', compute_type='int8'); print('ok')")
    endpoints = [config.get("HF_ENDPOINT") or None]
    if HF_MIRROR not in endpoints:
        endpoints.append(HF_MIRROR)
    error = ""
    for endpoint in endpoints:
        with _lock:
            if tier not in _jobs:      # 用户取消了
                return
        if endpoint:
            env["HF_ENDPOINT"] = endpoint
        else:
            env.pop("HF_ENDPOINT", None)
        try:
            proc = subprocess.Popen([sys.executable, "-c", code], env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
            with _lock:
                if tier not in _jobs:
                    proc.terminate()
                    return
                _jobs[tier]["proc"] = proc
            out, err = proc.communicate(timeout=3 * 3600)
        except (OSError, subprocess.TimeoutExpired) as exc:
            error = str(exc)
            continue
        if proc.returncode == 0 and installed(tier):
            updates = {"ASR_MODEL": tier}
            if endpoint and endpoint != config.get("HF_ENDPOINT"):
                updates["HF_ENDPOINT"] = endpoint   # 镜像能用就记住，下次直接走镜像
            config.save(updates)
            with _lock:
                _jobs[tier] = {"state": "done", "finished": time.time()}
            return
        error = (err or out or "").strip().splitlines()[-1:] or ["下载没有完成"]
        error = error[0]
    with _lock:
        if tier not in _jobs:
            return
        _jobs[tier] = {"state": "failed", "error": "下载没有完成，检查一下网络后再试" + (f"（{error[:120]}）" if error else "")}


def download(tier: str) -> dict:
    """开始下载；已经下好就直接切换过去。"""
    if tier not in TIER_IDS:
        raise ValueError("没有这个档位")
    if installed(tier):
        return use(tier)
    with _lock:
        if (_jobs.get(tier) or {}).get("state") == "running":
            return status()
        if any(j.get("state") == "running" for j in _jobs.values()):
            raise ValueError("另一个模型正在下载，等它下完再换")
        _jobs[tier] = {"state": "running", "started": time.time()}
    threading.Thread(target=_download, args=(tier,), daemon=True, name=f"asr-download-{tier}").start()
    return status()


def use(tier: str) -> dict:
    if tier not in TIER_IDS:
        raise ValueError("没有这个档位")
    if not installed(tier):
        raise ValueError("这个模型还没下载")
    config.save({"ASR_MODEL": tier})
    return status()


def cancel(tier: str) -> dict:
    with _lock:
        proc = (_jobs.get(tier) or {}).get("proc")
        _jobs.pop(tier, None)
    if proc and proc.poll() is None:
        proc.terminate()
    return status()
