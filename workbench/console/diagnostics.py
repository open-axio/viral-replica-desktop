"""「导出问题报告」：出了问题时，用户一键打一个小 zip 发给我们看。

只装文字：软件版本、电脑配置、设置（Key 全部去掉）、软件日志的最后一段、当前项目的处理记录。
不装视频、照片、声音；日志和记录里凡是出现已保存的 Key、或长得像 Key 的字符串，一律换成 ***。
"""
from __future__ import annotations

import json
import platform
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

from . import config, paths, store

LOG_TAIL = 400_000  # 每个日志文件只取最后 ~400KB
_KEYISH = re.compile(r"(sk-[A-Za-z0-9_\-]{12,}|Bearer\s+[A-Za-z0-9._\-]{12,}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-.]+)")


def _secrets() -> list[str]:
    values = config.load()
    return sorted({v for k, v in values.items() if k in config.SECRET_KEYS and isinstance(v, str) and len(v) >= 6},
                  key=len, reverse=True)


def scrub(text: str, secrets: list[str] | None = None) -> str:
    for value in secrets if secrets is not None else _secrets():
        text = text.replace(value, "***")
    return _KEYISH.sub("***", text)


def _tail(path: Path, secrets: list[str]) -> str:
    try:
        with path.open("rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - LOG_TAIL))
            raw = fh.read()
    except OSError:
        return ""
    text = raw.decode("utf-8", "replace")
    if size > LOG_TAIL:
        text = "…（前面省略）\n" + text.split("\n", 1)[-1]
    return scrub(text, secrets)


def _settings() -> dict:
    out = {}
    for key, value in config.load().items():
        out[key] = ("已填写" if value else "") if key in config.SECRET_KEYS else value
    return out


def _project(pid: str, secrets: list[str]) -> dict | None:
    try:
        data = store.load(pid)
    except Exception:
        return None
    keep = ("id", "name", "created_at", "origin", "source", "analysis", "routes", "runs", "images", "log", "jobs",
            "segments_plan", "director", "final", "final_preview")
    slim = {k: data.get(k) for k in keep if k in data}
    # 分析结果里的长文本（逐字稿、分镜描述）没必要带走，留状态就够查问题
    analysis = slim.get("analysis")
    if isinstance(analysis, dict):
        slim["analysis"] = {k: v for k, v in analysis.items() if k not in {"transcript", "shots", "words"}}
        slim["analysis"]["shots_count"] = len(analysis.get("shots") or [])
    return json.loads(scrub(json.dumps(slim, ensure_ascii=False, default=str), secrets))


def build(pid: str | None = None) -> Path:
    secrets = _secrets()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = paths.RUNTIME_DIR / "temp" / "diagnostics"
    shutil.rmtree(out_dir, ignore_errors=True)  # 只留最新一份
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"爆款复刻-问题报告-{stamp}.zip"
    version = (Path(__file__).resolve().parents[1] / "VERSION")
    try:
        from . import local_llm
        hardware = local_llm.hardware()
    except Exception as exc:  # 体检失败也要能导出
        hardware = {"error": str(exc)}
    try:
        disk = shutil.disk_usage(paths.DATA_DIR if hasattr(paths, "DATA_DIR") else paths.RUNTIME_DIR)
        free_gb = round(disk.free / 1e9, 1)
    except OSError:
        free_gb = None
    summary = {
        "exported_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "version": version.read_text(encoding="utf-8").strip() if version.is_file() else "",
        "system": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "python": sys.version.split()[0],
        "disk_free_gb": free_gb,
        "hardware": hardware,
        "project": pid or None,
        "projects": [{k: p.get(k) for k in ("id", "name", "analysis", "has_breakdown", "has_final")}
                     for p in store.list_projects()][:30],
    }
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("说明.txt", "这是爆款复刻工作台的问题报告，只有文字：版本、电脑配置、设置（不含 Key）、软件日志、项目处理记录。\n"
                               "不含任何视频、照片和声音。\n")
        zf.writestr("summary.json", json.dumps(summary, ensure_ascii=False, indent=2, default=str))
        zf.writestr("settings.json", json.dumps(_settings(), ensure_ascii=False, indent=2))
        for name in ("server.log", "desktop-server.log"):
            log = paths.RUNTIME_DIR / name
            if log.is_file():
                zf.writestr(f"logs/{name}", _tail(log, secrets))
        if pid:
            project = _project(pid, secrets)
            if project is not None:
                zf.writestr("project.json", json.dumps(project, ensure_ascii=False, indent=2, default=str))
    return target
