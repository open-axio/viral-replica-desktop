"""「找爆款 → 同款复刻」：把桌面版内置浏览窗口里正在看的视频建成一个新项目。

桌面外壳（build/browse.js）在用户自己浏览的页面里点「同款复刻」后，把视频（有的平台
音画分开，另有一条音频）下载到 IMPORT_DIR，再调 POST /api/import-video。这里只接受
IMPORT_DIR 里的文件：不让接口变成「把本机任意文件拷进项目」的入口。
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from . import media, paths, pipeline, store

IMPORT_DIR = paths.RUNTIME_DIR / "temp" / "browse-import"

PLATFORMS = {"douyin": "抖音", "xiaohongshu": "小红书", "bilibili": "B站", "other": "网页"}
_MAX_TEXT = 2000


def _text(value, limit: int = 200) -> str:
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value or "")).strip()
    return s[:limit]


def _url(value) -> str:
    s = _text(value, 2000)
    return s if re.match(r"^https?://", s) else ""


def _inside_import_dir(raw) -> Path:
    if not raw:
        raise ValueError("没有拿到视频文件")
    p = Path(str(raw)).resolve()
    root = IMPORT_DIR.resolve()
    try:
        p.relative_to(root)
    except ValueError:
        raise ValueError("视频文件不在导入目录里") from None
    if not p.is_file() or p.stat().st_size <= 0:
        raise ValueError("视频文件是空的，换一条再试")
    return p


def clean_origin(raw: dict) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    platform = raw.get("platform") if raw.get("platform") in PLATFORMS else "other"
    stats = {}
    for k, v in (raw.get("stats") or {}).items() if isinstance(raw.get("stats"), dict) else []:
        if k in {"likes", "comments", "collects", "shares", "views", "coins"} and v not in (None, ""):
            stats[k] = _text(v, 20)
    comments = []
    for c in (raw.get("comments") or [])[:20] if isinstance(raw.get("comments"), list) else []:
        if isinstance(c, dict) and _text(c.get("text")):
            comments.append({"user": _text(c.get("user"), 40), "text": _text(c.get("text"), 300),
                             "likes": _text(c.get("likes"), 20)})
    return {
        "platform": platform,
        "platform_name": PLATFORMS[platform],
        "url": _url(raw.get("url")),
        "title": _text(raw.get("title"), 200),
        "desc": _text(raw.get("desc"), _MAX_TEXT),
        "author": _text(raw.get("author"), 60),
        "author_url": _url(raw.get("author_url")),
        "published": _text(raw.get("published"), 40),
        "stats": stats,
        "comments": comments,
        "keyword": _text(raw.get("keyword"), 60),
        "captured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def project_name(origin: dict) -> str:
    who = origin.get("author") or ""
    what = re.sub(r"\s+", " ", origin.get("title") or origin.get("desc") or "").strip()
    what = re.sub(r"#\S+", "", what).strip()[:16]
    parts = [p for p in (origin["platform_name"], who, what) if p]
    return " · ".join(parts)[:40] or "同款复刻"


def import_video(body: dict) -> dict:
    """新建项目 + 放入参考视频 + 记下来源。返回 {"id": 项目 id}。"""
    body = body if isinstance(body, dict) else {}
    video = _inside_import_dir(body.get("video"))
    audio = _inside_import_dir(body.get("audio")) if body.get("audio") else None
    origin = clean_origin(body.get("origin"))
    merged = None
    if audio:
        # B 站等平台音画分开下发：合成一个 mp4 再当参考视频
        media.require_ffmpeg()
        merged = IMPORT_DIR / f"merged-{time.time_ns()}.mp4"
        media._run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-i", str(audio),
                    "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", str(merged)], 600)
        source_file = merged
    else:
        source_file = video
    data = store.create(_text(body.get("name"), 40) or project_name(origin))
    pid = data["id"]
    try:
        pipeline.save_source(pid, f"{origin['platform']}-{time.strftime('%m%d-%H%M')}.mp4", source_file)
    except Exception:
        _cleanup(video, audio, merged)
        raise
    store.update(pid, lambda d: d.update(origin=origin))
    store.log(pid, f"从{origin['platform_name']}导入参考视频" + (f"：{origin['url']}" if origin["url"] else ""))
    _cleanup(video, audio, merged)
    return {"id": pid, "name": store.load(pid)["name"]}


def _cleanup(*files) -> None:
    for f in files:
        if f:
            try:
                Path(f).unlink(missing_ok=True)
            except OSError:
                pass
