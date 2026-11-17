"""免费拆解的成品：一份能直接带走的报告 + 字幕 + 分镜图，打成一个 zip。

全部用前四步的本地产物拼出来，不调用任何模型，不需要 Key。
产物放在 analysis/free/，不碰 storyboard（那是付费拆解之后、带人物/商品标注的正式分镜）。
"""
from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

from . import forensics

FOLDER = "free"
ZIP_NAME = "免费拆解包.zip"
REPORT_NAME = "拆解报告.md"


def shot_lines(transcript: dict | None, start: float, end: float) -> str:
    """这一镜里说了什么：按句子中点落在镜头区间内取，避免一句话被两镜重复计入。"""
    out = []
    for seg in (transcript or {}).get("segments") or []:
        mid = (float(seg.get("start", 0)) + float(seg.get("end", 0))) / 2
        if start <= mid < end and str(seg.get("text") or "").strip():
            out.append(str(seg["text"]).strip())
    return " ".join(out)


def _fmt(t: float) -> str:
    t = max(0.0, float(t))
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def report_md(info: dict, shots: list[dict], transcript: dict | None, forensic: dict | None,
              source_name: str) -> str:
    verdicts = forensics.by_index(forensic)
    words = sum(len(s.get("words") or []) for s in (transcript or {}).get("segments") or [])
    lines = [
        f"# 拆解报告 · {source_name}", "",
        "全部在本机完成，没有调用任何模型，没有产生费用。", "",
        "## 视频信息", "",
        f"- 时长 {float(info.get('duration') or 0):.1f} 秒 · {info.get('width')}×{info.get('height')} · "
        f"{float(info.get('fps') or 0):.0f}fps · {'有' if info.get('audio_stream_count') else '无'}音轨",
        f"- 台词：{'识别到 %d 个词' % words if words else '没有识别台词'}",
        f"- 镜头：{len(shots)} 个，平均 {sum(s['end'] - s['start'] for s in shots) / max(1, len(shots)):.1f} 秒",
    ]
    if forensic:
        c = forensic.get("counts") or {}
        lines.append("- 拍摄方式：" + " · ".join(f"{forensics.CLASSES[k]} {c.get(k, 0)}" for k in forensics.CLASSES))
    lines += ["", "## 逐镜", "", "| 镜头 | 时间 | 拍摄方式 | 依据 | 台词 |", "|---|---|---|---|---|"]
    for s in shots:
        v = verdicts.get(s["index"]) or {}
        kind = v.get("class_zh", "—")
        why = "、".join(v.get("tags") or []) or "—"
        said = shot_lines(transcript, s["start"], s["end"]).replace("|", "/") or "（无台词）"
        lines.append(f"| {s['index']} | {_fmt(s['start'])}–{_fmt(s['end'])} | {kind} | {why} | {said} |")
    lines += ["", "## 包里还有", "",
              "- `分镜图-*.jpg`：每个镜头一格，9 格一张",
              "- `台词表.srt`：字幕文件，可直接导入剪映等剪辑软件（没有台词时不附）",
              "- `拍摄方式.md`：每个镜头的完整判定依据（没做认拍摄方式时不附）", "",
              "> 拍摄方式来自本地像素取证，没有用看图模型，供复刻时参考。", ""]
    return "\n".join(lines)


def build(adir: Path, info: dict, shots: list[dict], transcript: dict | None, forensic: dict | None,
          source_name: str) -> dict:
    """生成 analysis/free/ 下的报告、分镜图和 zip。返回相对 analysis/ 的文件名。"""
    from .storyboard import render_sheets

    folder = adir / FOLDER
    if folder.exists():
        shutil.rmtree(folder)
    tiles = folder / "tiles"
    tiles.mkdir(parents=True)
    cells = []
    for s in shots:
        frame = adir / "frames" / f"shot-{s['index']:03d}.jpg"
        if not frame.is_file():
            continue
        name = f"cell-{s['index']:03d}.jpg"
        shutil.copyfile(frame, tiles / name)
        cells.append({"id": f"c{s['index']:03d}", "index": s["index"], "start": s["start"], "end": s["end"], "file": name})
    sheets = []
    if cells:
        for i, sheet in enumerate(render_sheets(cells, tiles), start=1):
            target = folder / f"分镜图-{i:02d}.jpg"
            (tiles / Path(sheet["file"]).name).replace(target)
            sheets.append(target.name)
    shutil.rmtree(tiles)

    report = folder / REPORT_NAME
    report.write_text(report_md(info, shots, transcript, forensic, source_name), encoding="utf-8")
    extras = [p for p in (adir / "台词表.srt", adir / "拍摄方式.md") if p.is_file()]
    bundle = folder / ZIP_NAME
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(report, report.name)
        for name in sheets:
            z.write(folder / name, name)
        for p in extras:
            z.write(p, p.name)
    return {"report": f"{FOLDER}/{REPORT_NAME}", "zip": f"{FOLDER}/{ZIP_NAME}",
            "sheets": [f"{FOLDER}/{n}" for n in sheets]}
