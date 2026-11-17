"""04 认拍摄方式：用 rea-video 的本地像素取证，逐镜判断这一镜是拍的、AI 生成的，还是做出来的图文动画。

镜号对齐是这一步的硬约束：rea-video 自己的切镜逻辑和 03 不一样，这里不用它的切镜，
直接把 03 的 merged_shots 当成镜头表喂进去，输出按 03 的镜号 1:1 排列。条数或区间
对不上就抛错，宁可这一步失败，也不让两套镜号混进后面的数据。

省时间的地方：rea-video 自己跑时要先整片逐帧解码一遍做切镜（build_track），这一步
整个跳过。取证本身要看每一镜里连续帧之间的变化（重复帧、帧率转换的锐度周期、整帧
刚体运动），03 抽的单张关键帧不够用，所以每一镜仍会按 480 宽解码一次。

全程本地 CPU，不调用任何模型接口，不需要 Key。
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Callable

LOG = logging.getLogger(__name__)

ENGINE = "rea-video 0.1.0 · 本地像素取证"

#: 三类：复刻时这一镜该去拍、该让模型生成、还是该用模板/剪辑软件做
CLASSES = {"live": "实拍", "ai": "AI 生成", "graphic": "图文动画"}
#: rea-video 的 11 个细分标签归到三类（见 vendor/rea_video/classify.py 的 LABELS）
CLASS_OF = {
    "live_action": "live", "film_footage": "live", "stop_motion": "live",
    "ai_video": "ai", "avatar": "ai",
    "cg_3d": "graphic", "code_render": "graphic", "screen_capture": "graphic",
    "still_motion": "graphic", "static_hold": "graphic", "anim_2d": "graphic",
}

#: 「深度取证」默认对这么长以内的视频开启。纯 CPU 下 71 秒视频实测约 2.5 分钟。
DEFAULT_MAX_SECONDS = 120.0


class AlignmentError(RuntimeError):
    """取证结果和 03 的镜头表对不上。"""


PIP_PACKAGE = "opencv-python-headless"
PIP_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"


def missing_dependency() -> str | None:
    """取证要用 OpenCV 和 NumPy。缺的话返回缺的模块名。"""
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
    except ImportError as exc:
        return exc.name or "cv2"
    return None


def install_dependency() -> str | None:
    """老用户的运行环境是在加入这一步之前装的，没有 OpenCV：用运行环境自带的 uv 补装一次。

    先走官方源，失败再走清华镜像（和 install.sh 一致）。成功返回 None，失败返回给用户看的原因。"""
    import importlib
    import subprocess
    import sys

    from . import paths
    uv = paths.RUNTIME_DIR / "uv" / ("uv.exe" if os.name == "nt" else "uv")
    if not uv.is_file():
        return "找不到运行环境里的安装工具，没法自动补装"
    last = ""
    for extra in ([], ["--index-url", PIP_MIRROR]):
        try:
            done = subprocess.run([str(uv), "pip", "install", "--python", sys.executable, PIP_PACKAGE, *extra],
                                  capture_output=True, text=True, timeout=600)
        except (OSError, subprocess.TimeoutExpired) as exc:
            last = str(exc)
            continue
        if done.returncode == 0:
            importlib.invalidate_caches()
            return None if missing_dependency() is None else "装好了但还是加载不了，重启一次应用再试"
        last = (done.stderr or done.stdout or "").strip().splitlines()[-1:] or [""]
        last = last[0]
    return "网络不通，没装上" + (f"（{last[:120]}）" if last else "")


def decide_run(cfg: dict, duration: float) -> tuple[bool, str]:
    """按设置决定这次跑不跑。返回 (是否运行, 不跑时的说明)。

    DEEP_FORENSICS：auto（默认，按时长）/ on / off
    DEEP_FORENSICS_MAX_SECONDS：auto 模式下的时长上限，默认 120
    """
    mode = str(cfg.get("DEEP_FORENSICS") or "auto").strip().lower()
    if mode in ("off", "0", "false", "no"):
        return False, "设置里关闭了「深度取证」"
    if mode in ("on", "1", "true", "yes"):
        return True, ""
    try:
        limit = float(cfg.get("DEEP_FORENSICS_MAX_SECONDS") or DEFAULT_MAX_SECONDS)
    except (TypeError, ValueError):
        limit = DEFAULT_MAX_SECONDS
    if duration > limit:
        return False, (f"视频 {duration:.0f} 秒，超过 {limit:.0f} 秒默认不做「深度取证」（纯 CPU 较慢）；"
                       "需要时在设置里把「深度取证」改成 on")
    return True, ""


def _models_dir() -> Path:
    from . import paths
    return paths.RUNTIME_DIR / "models" / "rea-video"


def _to_shot(rv_shots, s: dict, fps: float):
    start_frame = max(0, int(round(float(s["start"]) * fps)))
    end_frame = max(start_frame + 1, int(round(float(s["end"]) * fps)))
    return rv_shots.Shot(index=int(s["index"]), start_frame=start_frame, end_frame=end_frame, fps=fps)


def _short(line: str, limit: int = 90) -> str:
    line = " ".join(str(line).split())
    return line if len(line) <= limit else line[:limit - 1] + "…"


def analyze(src: Path, shots: list[dict], progress: Callable[[int, int], None] | None = None) -> dict:
    """对 03 的每一镜做取证。shots 就是 boundaries.json 里的 merged_shots。"""
    os.environ.setdefault("REA_VIDEO_MODELS", str(_models_dir()))
    from .vendor.rea_video import classify, faces as rv_faces, features, i18n, media as rv_media, overlay, probe
    from .vendor.rea_video import shots as rv_shots

    i18n.set_lang("zh")
    t0 = time.time()
    info = rv_media.video_info(src)
    prov = probe.provenance(info)
    fps = float(info.fps or 30.0)

    records: list[dict] = []
    for n, s in enumerate(shots, start=1):
        shot = _to_shot(rv_shots, s, fps)
        smp = features.collect_samples(str(src), info, shot)
        lbox = features.photo_letterbox(smp.frames)
        crop = tuple(lbox["box"]) if lbox else None
        # 上下黑边会被当成「平坦、少色、静止」的渲染特征：有黑边就只量画面本身
        feats = features.shot_features(features.collect_samples(str(src), info, shot, crop=crop) if crop else smp, fps)
        pic = [features.crop_box(f, lbox["box"]) for f in smp.frames] if lbox else smp.frames
        fd = rv_faces.shot_faces(pic)
        areas = [p["face"]["area"] for p in fd["frames"] if p.get("face")]
        feats["face_presence"] = fd["presence"]
        feats["face_area"] = float(sorted(areas)[len(areas) // 2]) if areas else 0.0
        records.append({"shot": s, "duration": shot.duration, "features": feats, "faces": fd["presence"],
                        "overlay": overlay.static_overlays(smp.frames)})
        if progress:
            progress(n, len(shots))

    # 整片级事实（是否经过平台转码、是否原生 30fps）会改变每一镜的判定，所以先量完所有镜头再判
    vctx = classify.video_context(records, prov, fps)
    out: list[dict] = []
    for rec in records:
        probs, evidence, facts = classify.deterministic(rec["features"], rec["overlay"], None, rec["faces"], None, prov,
                                                        fps=fps, ctx=vctx)
        # 只有像素取证、没有看图模型时，上游也是直接取最高的细分标签（见 rea_video.pipeline.finalize）
        label, conf = classify.top(probs)
        cls = CLASS_OF.get(label, "graphic")
        s = rec["shot"]
        out.append({
            "index": s["index"], "start": s["start"], "end": s["end"],
            "class": cls, "class_zh": CLASSES[cls],
            "label": label, "label_zh": str(classify.LABEL_ZH[label]),
            "confidence": round(float(conf), 3),
            "evidence": [_short(e) for e in evidence[:3]],
            "tags": short_tags(label, rec["features"], facts),
            "runner_up": [{"label": k, "label_zh": str(classify.LABEL_ZH[k]), "p": round(float(v), 3)}
                          for k, v in sorted(probs.items(), key=lambda kv: -kv[1])[1:3]],
            "temporal_family": facts.get("temporal_family"),
        })
    check_alignment(shots, out)
    return {"engine": ENGINE, "seconds": round(time.time() - t0, 1),
            "context": {k: vctx.get(k) for k in ("transcoded", "platform", "native30", "fps")},
            "counts": {c: sum(1 for r in out if r["class"] == c) for c in CLASSES}, "shots": out}


def short_tags(label: str, feats: dict, facts: dict) -> list[str]:
    """把取证特征压成界面上的短标签（「凭什么这么判断」），最多 3 个，和判定方向一致的排前面。

    完整的判定依据长句仍在 evidence 里，供报告和 prompt 使用。"""
    cls = CLASS_OF.get(label, "graphic")
    noise = float(feats.get("noise_sigma") or 0)
    tags: list[tuple[int, str]] = []          # (与判定是否一致：0 一致 / 1 中性, 文字)
    fam = facts.get("temporal_family")
    if fam == "frozen":
        tags.append((0, "画面完全静止"))
    elif fam == "planar":
        tags.append((0, "整张图在推拉平移"))
    elif fam == "mostly_static":
        tags.append((0, "只有局部元素在动"))
    if facts.get("pulldown") and fam == "dynamic":
        tags.append((0 if cls == "ai" else 1, "有规律的重复帧"))
    if (feats.get("sharp_period_ac") or 0) > 0.45 and fam == "dynamic":
        tags.append((0 if cls == "ai" else 1, "清晰度周期起伏"))
    if noise >= 0.9:
        tags.append((0 if cls == "live" else 1, "有传感器噪点"))
    elif noise < 0.5 and fam != "frozen":
        tags.append((0 if cls != "live" else 1, "几乎没有噪点"))
    if (facts.get("graphic_score") or 0) > 0.6:
        tags.append((0 if cls == "graphic" else 1, "大面积纯色色块"))
    elif (feats.get("palette95") or 0) >= 150:
        tags.append((0 if cls != "graphic" else 1, "色彩层次丰富"))
    cam = feats.get("camera")
    if cam == "handheld_like":
        tags.append((0 if cls == "live" else 1, "手持抖动"))
    elif cam == "smooth_move":
        tags.append((1, "镜头平稳运动"))
    elif cam == "static" and fam == "dynamic":
        tags.append((1, "固定机位"))
    if facts.get("big_face"):
        tags.append((1, "人物近景"))
    if (facts.get("ui_text") or 0) > 0.5:
        tags.append((0 if cls == "graphic" else 1, "界面小字较多"))
    seen, out = set(), []
    for _, t in sorted(tags, key=lambda x: x[0]):
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out[:3]


def check_alignment(shots: list[dict], result: list[dict]) -> None:
    """取证结果必须和 03 的镜头表一一对应：条数相同，第 i 条的镜号和时间区间等于第 i 个镜头。"""
    if len(result) != len(shots):
        raise AlignmentError(f"取证结果 {len(result)} 条，03 有 {len(shots)} 个镜头")
    for i, (a, b) in enumerate(zip(shots, result)):
        if a["index"] != b["index"] or a["start"] != b["start"] or a["end"] != b["end"]:
            raise AlignmentError(f"第 {i + 1} 条取证结果对应 #{b['index']} {b['start']}–{b['end']}s，"
                                 f"应为 #{a['index']} {a['start']}–{a['end']}s")


def by_index(result: dict | None) -> dict[int, dict]:
    return {r["index"]: r for r in (result or {}).get("shots") or []}


def prompt_lines(result: dict | None, start: float | None = None, end: float | None = None) -> list[str]:
    """给 05/06 prompt 用：每镜一行「本镜判定：AI 生成（依据：…）」。可按时间段筛选。"""
    lines = []
    for r in (result or {}).get("shots") or []:
        if start is not None and end is not None and not (r["start"] < end and r["end"] > start):
            continue
        why = "；".join(_short(e, 60) for e in (r.get("evidence") or [])[:2]) or "无明显特征"
        detail = f"，细分：{r['label_zh']}" if r["label_zh"] != r["class_zh"] else ""
        lines.append(f"镜 {r['index']}（{r['start']:.2f}–{r['end']:.2f}s）本镜判定：{r['class_zh']}{detail}，"
                     f"把握 {r['confidence']:.0%}（依据：{why}）")
    return lines


def report_md(result: dict) -> str:
    """免费层也能下载的人读版报告。"""
    c = result.get("counts") or {}
    head = [
        "# 拍摄方式（逐镜判定）", "",
        f"引擎：{result.get('engine')} · 用时 {result.get('seconds')} 秒 · 镜号与「03 切点检测」一致", "",
        "共 " + "，".join(f"{CLASSES[k]} {c.get(k, 0)} 镜" for k in CLASSES), "",
        "> 判定来自本地像素取证（噪点、重复帧、帧率转换痕迹、整帧运动、平坦色块等），没有用看图模型，"
        "准确率尚未用已知来源的片子系统测过，供复刻时参考。", "",
        "| 镜号 | 时间 | 判定 | 细分 | 把握 | 依据 |", "|---|---|---|---|---|---|",
    ]
    rows = [f"| {r['index']} | {r['start']:.2f}–{r['end']:.2f}s | {r['class_zh']} | {r['label_zh']} | "
            f"{r['confidence']:.0%} | {'<br>'.join(e.replace('|', '/') for e in r.get('evidence') or [])} |"
            for r in result.get("shots") or []]
    return "\n".join(head + rows) + "\n"
