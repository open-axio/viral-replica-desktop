"""更多生视频厂商：火山方舟 Seedance、阿里云百炼万相、MiniMax 海螺。

和三方渠道共用同一套「免费预览 → 确认 → 生成 → 查询 → 下载」流程：预览包、冻结任务文件、确认哈希都不变，
只是确认后不交给三方渠道脚本，而是由这里直接请求厂商接口。运行记录写成和三方渠道一样的
jimmy-runs/<job>/state.json（tasks.<段落>.phase / jimmy_task_id / local_path / error），
所以失败重试、自动查询、手动恢复都走原来的逻辑。

安全规则和三方渠道一致：
- 只有「还没把请求发出去」的失败才允许自动重试（request 为空）；
- 请求发出去但没收到答复 → submission_outcome_unknown，不会再发第二次，可能已经计费；
- 已有远端任务 ID 时只查询、不重新提交。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from ... import config, llm, store
from . import vendor_errors

VENDORS = {
    "ark": {
        "name": "火山方舟 Seedance", "account": "火山方舟", "key": "DOUBAO_API_KEY", "key_channel": "doubao",
        "max_images": 9, "reference_video": False, "voice": True,
        "models": [
            {"id": "doubao-seedance-2-0-260128", "name": "Seedance 2.0", "note": "推荐：画质和动作都好，最多 9 张参考图"},
            {"id": "doubao-seedance-2-0-fast-260128", "name": "Seedance 2.0 Fast", "note": "更快更便宜，720p"},
            {"id": "doubao-seedance-2-5-260628", "name": "Seedance 2.5", "note": "最新，效果最好也最贵"},
        ],
    },
    "bailian": {
        "name": "阿里云百炼 万相", "account": "阿里云百炼", "key": "QWEN_API_KEY", "key_channel": "qwen",
        "max_images": 5, "reference_video": True, "voice": True,
        "models": [
            {"id": "wan2.7-r2v", "name": "万相 2.7 参考生视频", "note": "能参考原片动作；参考图和参考视频合计最多 5 个"},
        ],
    },
    "kling": {
        "name": "可灵（经阿里云百炼）", "account": "阿里云百炼", "key": "QWEN_API_KEY", "key_channel": "qwen",
        "max_images": 4, "reference_video": False, "voice": False,
        "models": [
            {"id": "kling/kling-v3-omni-video-generation", "name": "可灵 3.0 Omni", "note": "多张参考图锁定人物和商品，动作自然"},
        ],
    },
    "minimax": {
        "name": "MiniMax 海螺", "account": "MiniMax", "key": "MINIMAX_API_KEY", "key_channel": "minimax",
        "max_images": 1, "reference_video": False, "voice": False,
        "models": [
            {"id": "MiniMax-Hailuo-2.3", "name": "海螺 2.3", "note": "人物动作自然；只用第一张参考图当开头画面，出 6 或 10 秒"},
            {"id": "MiniMax-Hailuo-02", "name": "海螺 02", "note": "上一代"},
        ],
    },
}
POLL_SECONDS = 10
_CTX = threading.local()  # 当前在跑哪家、哪个模型：报错时说清楚该去哪里处理


class VendorError(Exception):
    def __init__(self, message: str, *, kind: str = "unknown", technical: str = ""):
        super().__init__(message)
        self.message, self.kind, self.technical = message, kind, technical


def is_vendor(channel: str | None) -> bool:
    return channel in VENDORS


def default_model(channel: str) -> str:
    return VENDORS[channel]["models"][0]["id"]


def model_name(channel: str, model: str) -> str:
    meta = VENDORS[channel]
    found = next((m["name"] for m in meta["models"] if m["id"] == model), model)
    return f"{meta['name'].split(' ')[0]} · {found}"


def key_ready(channel: str) -> bool:
    return bool((config.load().get(VENDORS[channel]["key"]) or "").strip())


def _hailuo_duration(duration: int) -> int:
    return 6 if duration <= 6 else 10


def plan(channel: str, model: str | None, task: dict) -> dict:
    """预览时检查这一段能不能交给这家，返回实际会用的模型、计费说明和提示。不发任何网络请求。"""
    meta = VENDORS[channel]
    model = model or default_model(channel)
    images = task.get("images") or []
    videos = task.get("reference_videos") or []
    audios = task.get("reference_audios") or []
    duration = int(task.get("duration") or 5)
    warnings, used_images, used_video, used_voice = [], len(images), False, False
    if videos:
        if meta["reference_video"] and duration <= 10:
            used_video = True
        elif meta["reference_video"]:
            warnings.append(f"{meta['name']}带参考视频时最长只能出 10 秒，这段 {duration} 秒，所以这次不参考原片动作，只用参考图")
        else:
            warnings.append(f"{meta['name']}不能直接用本机的原片片段做动作参考，这次只用参考图。建议把这一段的生成方式改成「只用目标画面和照片」，"
                            "提示词会把动作写完整；想照着原片动作拍，请换三方渠道或阿里云百炼万相")
    if channel == "minimax" and len(images) > 1:
        warnings.append(f"海螺只用第一张参考图当开头画面，其余 {len(images) - 1} 张不会用到")
        used_images = 1
    if channel == "bailian" and len(images) + (1 if used_video else 0) > 5:
        raise VendorError(f"{meta['name']}参考图和参考视频合计最多 5 个，这段有 {len(images)} 张图"
                          + ("和 1 段参考视频" if used_video else "") + "：少选几张，或换一个生视频模型", kind="invalid_request")
    if len(images) > meta["max_images"] and channel != "minimax":
        raise VendorError(f"{meta['name']}最多 {meta['max_images']} 张参考图，这段有 {len(images)} 张", kind="invalid_request")
    if not used_images and not used_video:
        raise VendorError(f"{meta['name']}至少需要一张参考图：这一段只有原片片段，请先加一张参考图（人物、商品或分镜图）", kind="invalid_request")
    if audios:
        if meta["voice"] and all(Path(a.get("path") or a.get("url") or "").suffix.lower() in {".wav", ".mp3"} for a in audios):
            used_voice = True
        else:
            warnings.append(f"{meta['name']}用不了这条声线样本（只支持 wav / mp3，或这家不支持换声），这次声音由模型自己生成")
    out_seconds = _hailuo_duration(duration) if channel == "minimax" else duration
    if out_seconds != duration:
        warnings.append(f"海螺只能出 6 秒或 10 秒，这段 {duration} 秒，会生成 {out_seconds} 秒")
    note = f"输出 {out_seconds}s" + ("（含参考视频）" if used_video else "") + f"；按{meta['account']}账户计费，单价以对方后台为准"
    return {"channel": channel, "model": model, "warnings": warnings, "billing_note": note, "output_seconds": out_seconds,
            "use_video": used_video, "use_voice": used_voice}


# ---------- 网络 ----------

def _settings(channel: str) -> dict:
    values = config.load()
    meta = VENDORS[channel]
    key = (values.get(meta["key"]) or "").strip()
    if not key:
        raise VendorError(f"还没填{meta['account']}的 Key：在「设置 → 生视频模型」里填好再试", kind="auth")
    if channel == "ark":
        base = (values.get("DOUBAO_BASE_URL") or config.DEFAULTS["DOUBAO_BASE_URL"]).rstrip("/")
    elif channel in {"bailian", "kling"}:
        compat = (values.get("QWEN_BASE_URL") or config.DEFAULTS["QWEN_BASE_URL"]).rstrip("/")
        base = compat.replace("/compatible-mode/v1", "/api/v1") if "/compatible-mode/" in compat else "https://dashscope.aliyuncs.com/api/v1"
    else:
        base = (values.get("MINIMAX_BASE_URL") or config.DEFAULTS.get("MINIMAX_BASE_URL") or "https://api.minimaxi.com/v1").rstrip("/")
    return {"key": key, "base": base}


class _Sent(Exception):
    """请求已经发出，但没拿到明确答复。"""


def _request(req, *, timeout=120) -> dict:
    try:
        from ..usage import mark_network_request
        mark_network_request()
    except Exception:
        pass
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=llm._ssl_context()) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:800]
        exc.close()
        kind = "auth" if exc.code in (401, 403) else "quota" if exc.code == 429 else "invalid_request" if 400 <= exc.code < 500 else "transient"
        known = vendor_errors.explain(detail, getattr(_CTX, "account", "对方"), getattr(_CTX, "model", ""))
        if known and kind != "transient":
            raise VendorError(known[1], kind=known[0], technical=f"HTTP {exc.code} {detail}") from None
        raise VendorError(_hint(kind) + _brief(detail), kind=kind, technical=f"HTTP {exc.code} {detail}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise _Sent(f"{type(exc).__name__}: {exc}") from exc
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise _Sent("invalid JSON response") from None


def _hint(kind: str) -> str:
    return {"auth": "Key 不对或没开通这个模型。", "quota": "额度不够或请求太频繁，稍后再试。",
            "invalid_request": "请求被拒绝（可能是参考图或提示词没通过审核）。"}.get(kind, "服务暂时出错。")


def _brief(detail: str) -> str:
    try:
        data = json.loads(detail)
        err = data.get("error") if isinstance(data.get("error"), dict) else data.get("base_resp") or data
        return str(err.get("message") or err.get("msg") or err.get("status_msg") or "")[:200]
    except (ValueError, AttributeError):
        return ""


def _json_req(method: str, url: str, key: str, body: dict | None = None, headers: dict | None = None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    return urllib.request.Request(url, data=data, method=method,
                                  headers={"Content-Type": "application/json", "Authorization": "Bearer " + key, **(headers or {})})


def _file(item: dict) -> Path:
    path = Path(item["path"])
    if item.get("sha256") and store.sha256_file(path) != item["sha256"]:
        raise VendorError("参考素材在确认后被改动，请重新生成预览", kind="invalid_request")
    return path


def _data_uri(item: dict, kind: str = "image") -> str:
    path = _file(item)
    mime = mimetypes.guess_type(path.name)[0] or ("image/png" if kind == "image" else "audio/mpeg")
    if kind == "audio" and path.suffix.lower() == ".mp3":
        mime = "audio/mp3"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def _bailian_upload(s: dict, model: str, item: dict) -> str:
    """把本机文件传到百炼免费的临时存储（48 小时有效），换成 oss:// 地址。这一步不计费。"""
    path = _file(item)
    policy = _request(_json_req("GET", s["base"] + "/uploads?" + urllib.parse.urlencode({"action": "getPolicy", "model": model}), s["key"]))
    try:
        p = policy["data"]
        key = f"{p['upload_dir']}/{uuid.uuid4().hex[:8]}{path.suffix.lower()}"
        fields = {"OSSAccessKeyId": p["oss_access_key_id"], "Signature": p["signature"], "policy": p["policy"],
                  "x-oss-object-acl": p["x_oss_object_acl"], "x-oss-forbid-overwrite": p["x_oss_forbid_overwrite"],
                  "key": key, "success_action_status": "200"}
        host = p["upload_host"]
    except (KeyError, TypeError):
        raise VendorError("阿里云百炼没有给出上传地址", kind="transient", technical=json.dumps(policy, ensure_ascii=False)[:600]) from None
    boundary = "----vr" + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
                 f'Content-Type: {mimetypes.guess_type(path.name)[0] or "application/octet-stream"}\r\n\r\n'.encode()
                 + path.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(host, data=b"".join(parts), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=600, context=llm._ssl_context()) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        exc.close()
        raise VendorError("参考素材上传到阿里云百炼临时空间失败", kind="transient", technical=f"HTTP {exc.code} {detail}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise VendorError("参考素材上传到阿里云百炼临时空间失败，检查网络后重试", kind="transient", technical=str(exc)) from exc
    return "oss://" + key


def build_request(channel: str, model: str, task: dict, s: dict, info: dict):
    """组装提交任务的请求（百炼会先上传参考素材到临时空间）。"""
    images = task.get("images") or []
    prompt = task["prompt"]
    if task.get("reference_videos") and not info.get("use_video"):
        # 提示词是按「有视频1」写的，这次视频没发过去：说清楚，别让模型去找不存在的视频
        prompt = "（说明：这次没有提供参考视频，提到“视频1”的地方按文字描述的动作和机位来拍。）\n" + prompt
    duration = int(task["duration"])
    ratio = task.get("ratio") or "9:16"
    if channel == "ark":
        content = [{"type": "text", "text": prompt}]
        content += [{"type": "image_url", "image_url": {"url": _data_uri(i)}, "role": "reference_image"} for i in images]
        if info.get("use_voice"):
            content += [{"type": "audio_url", "audio_url": {"url": _data_uri(a, "audio")}, "role": "reference_audio"}
                        for a in task.get("reference_audios") or []]
        body = {"model": model, "content": content, "ratio": ratio, "duration": duration, "resolution": "720p",
                "generate_audio": True, "watermark": False}
        return _json_req("POST", s["base"] + "/contents/generations/tasks", s["key"], body)
    if channel == "bailian":
        media = [{"type": "reference_image", "url": _bailian_upload(s, model, i)} for i in images]
        if info.get("use_video"):
            media += [{"type": "reference_video", "url": _bailian_upload(s, model, v)} for v in (task.get("reference_videos") or [])[:1]]
        if info.get("use_voice") and media:
            media[0]["reference_voice"] = _bailian_upload(s, model, task["reference_audios"][0])
        body = {"model": model, "input": {"prompt": prompt, "media": media},
                "parameters": {"resolution": "720P", "ratio": ratio, "duration": duration, "watermark": False, "prompt_extend": False}}
        return _json_req("POST", s["base"] + "/services/aigc/video-generation/video-synthesis", s["key"], body,
                         {"X-DashScope-Async": "enable", "X-DashScope-OssResourceResolve": "enable"})
    if channel == "kling":
        media = [{"type": "refer", "url": _bailian_upload(s, model, i)} for i in images]
        # 可灵用 <<<image_1>>> 指代参考图；我们的提示词写的是「图1」
        text = re.sub(r"图\s*(\d+)", lambda m: f"<<<image_{m.group(1)}>>>", prompt)[:2500]
        body = {"model": model, "input": {"prompt": text, "media": media},
                "parameters": {"mode": "std", "aspect_ratio": ratio if ratio in {"16:9", "9:16", "1:1"} else "9:16",
                               "duration": duration, "audio": True, "watermark": False}}
        return _json_req("POST", s["base"] + "/services/aigc/video-generation/video-synthesis", s["key"], body,
                         {"X-DashScope-Async": "enable", "X-DashScope-OssResourceResolve": "enable"})
    if len(prompt) > 2000:
        prompt = prompt[:2000]
    body = {"model": model, "prompt": prompt, "first_frame_image": _data_uri(images[0]),
            "duration": _hailuo_duration(duration), "resolution": "768P", "prompt_optimizer": False}
    return _json_req("POST", s["base"] + "/video_generation", s["key"], body)


def _task_id(channel: str, data: dict) -> str:
    if channel == "ark":
        tid = data.get("id")
    elif channel in {"bailian", "kling"}:
        tid = (data.get("output") or {}).get("task_id")
    else:
        base = data.get("base_resp") or {}
        if base.get("status_code") not in (0, None):
            known = vendor_errors.explain(f"{base.get('status_code')} {base.get('status_msg')}", "MiniMax")
            if known:
                raise VendorError(known[1], kind=known[0], technical=json.dumps(data, ensure_ascii=False)[:600])
            raise VendorError(f"MiniMax：{base.get('status_msg') or '提交被拒绝'}",
                              kind="quota" if base.get("status_code") == 1008 else "auth" if base.get("status_code") in (1004, 2049) else "invalid_request",
                              technical=json.dumps(data, ensure_ascii=False)[:600])
        tid = data.get("task_id")
    if not tid:
        raise _Sent("submit response has no task id: " + json.dumps(data, ensure_ascii=False)[:300])
    return str(tid)


def query(channel: str, remote: str, s: dict) -> dict:
    """返回 {status: running|succeeded|failed, url?, message?, raw}。"""
    if channel == "ark":
        data = _request(_json_req("GET", f"{s['base']}/contents/generations/tasks/{urllib.parse.quote(remote)}", s["key"]))
        status = str(data.get("status") or "")
        if status == "succeeded":
            return {"status": "succeeded", "url": (data.get("content") or {}).get("video_url"), "raw": status}
        if status in {"failed", "expired", "cancelled"}:
            err = data.get("error") or {}
            return {"status": "failed", "message": err.get("message") or f"任务{status}", "raw": status}
        return {"status": "running", "raw": status}
    if channel in {"bailian", "kling"}:
        data = _request(_json_req("GET", f"{s['base']}/tasks/{urllib.parse.quote(remote)}", s["key"]))
        out = data.get("output") or {}
        status = str(out.get("task_status") or "")
        if status == "SUCCEEDED":
            return {"status": "succeeded", "url": out.get("video_url"), "raw": status}
        if status in {"FAILED", "CANCELED", "UNKNOWN"}:
            message = out.get("message") or ("任务不存在或已过期（超过 24 小时）" if status == "UNKNOWN" else f"任务{status}")
            return {"status": "failed", "message": message, "raw": status}
        return {"status": "running", "raw": status}
    data = _request(_json_req("GET", f"{s['base']}/query/video_generation?task_id={urllib.parse.quote(remote)}", s["key"]))
    status = str(data.get("status") or "")
    if status == "Success":
        info = _request(_json_req("GET", f"{s['base']}/files/retrieve?file_id={urllib.parse.quote(str(data.get('file_id')))}", s["key"]))
        return {"status": "succeeded", "url": (info.get("file") or {}).get("download_url"), "raw": status}
    if status == "Fail":
        return {"status": "failed", "message": (data.get("base_resp") or {}).get("status_msg") or "生成失败", "raw": status}
    return {"status": "running", "raw": status}


def _download(url: str, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(".part")
    req = urllib.request.Request(url)  # 结果链接自带签名，不能带上 Key
    with urllib.request.urlopen(req, timeout=600, context=llm._ssl_context()) as resp, temp.open("wb") as fh:
        while chunk := resp.read(1 << 20):
            fh.write(chunk)
    if temp.stat().st_size < 1024:
        temp.unlink(missing_ok=True)
        raise OSError("download failed: file too small")
    temp.replace(output)


# ---------- 运行记录（和三方渠道同格式） ----------

def _state_path(run_dir: Path) -> Path:
    return run_dir / "state.json"


def _child(run_dir: Path, tid: str) -> dict:
    try:
        state = json.loads(_state_path(run_dir).read_text(encoding="utf-8"))
        return (state.get("tasks") or {}).get(tid) or {}
    except (OSError, ValueError, AttributeError):
        return {}


def _write(run_dir: Path, tid: str, **changes) -> dict:
    run_dir.mkdir(parents=True, exist_ok=True)
    try:
        state = json.loads(_state_path(run_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    child = state.setdefault("tasks", {}).setdefault(tid, {})
    child.update(changes)
    child["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    store.atomic_write_json(_state_path(run_dir), state)
    return child


def _err(exc: Exception) -> dict:
    if isinstance(exc, VendorError):
        return {"type": "VendorError", "kind": exc.kind, "message": exc.message, "technical": exc.technical}
    return {"type": type(exc).__name__, "message": str(exc)}


def generate(channel: str, model: str, job_path: Path, run_dir: Path, tid: str, info: dict, *, timeout: int = 3600) -> dict:
    """确认后跑一次：准备素材 → 提交（只发一次）→ 查询 → 下载。"""
    _CTX.account, _CTX.model = VENDORS[channel]["account"], model
    job = json.loads(job_path.read_text(encoding="utf-8"))
    task = next(t for t in job["tasks"] if t["id"] == tid)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "job.json").write_bytes(job_path.read_bytes())
    _write(run_dir, tid, phase="preparing", status="preparing", channel=channel, model=model, request=None,
           jimmy_task_id=None, error=None)
    try:
        s = _settings(channel)
        req = build_request(channel, model, task, s, info)
    except Exception as exc:  # 还没提交：没有费用，允许重试
        return _write(run_dir, tid, phase="failed", status="failed", error=_err(exc))
    _write(run_dir, tid, phase="submitting", status="submitting", request={"url": req.full_url, "sent_at": time.time()})
    try:
        remote = _task_id(channel, _request(req, timeout=300))
    except VendorError as exc:
        # 对方明确拒绝：任务没创建。限流和服务端错误可以安全地重新提交。
        retry_ok = exc.kind in {"quota", "transient"}
        return _write(run_dir, tid, phase="failed", status="rejected", error=_err(exc),
                      **({"request": None} if retry_ok else {}))
    except _Sent as exc:
        return _write(run_dir, tid, phase="submission_outcome_unknown", status="unknown",
                      error={"type": "SubmissionUnknown", "message": f"请求已发出但没收到答复，可能已经计费：先去{VENDORS[channel]['account']}后台看看有没有这条任务。（{exc}）"})
    _write(run_dir, tid, phase="submitted", status="submitted", jimmy_task_id=remote, submitted_at=time.time())
    return poll(channel, run_dir, tid, timeout=timeout)


def poll(channel: str, run_dir: Path, tid: str, *, timeout: int = 3600) -> dict:
    child = _child(run_dir, tid)
    _CTX.account, _CTX.model = VENDORS[channel]["account"], child.get("model") or ""
    remote = child.get("jimmy_task_id")
    if not remote:
        raise VendorError("这次生成还没有远端任务 ID，不能查询")
    s = _settings(channel)
    deadline = time.time() + timeout
    while True:
        try:
            result = query(channel, remote, s)
        except (_Sent, VendorError) as exc:
            if isinstance(exc, VendorError) and exc.kind in {"auth", "invalid_request"}:
                return _write(run_dir, tid, phase="failed", status="error", error=_err(exc))
            return _write(run_dir, tid, phase="running", status="query_failed",
                          error={"type": "QueryError", "message": f"GET transport failed: {exc}"})
        if result["status"] == "succeeded":
            if not result.get("url"):
                return _write(run_dir, tid, phase="failed", status="error",
                              error={"type": "VendorError", "message": "任务成功了，但没有返回视频地址"})
            out = run_dir / f"{tid}.mp4"
            try:
                _download(result["url"], out)
            except (urllib.error.URLError, OSError) as exc:
                return _write(run_dir, tid, phase="running", status="download_failed",
                              error={"type": "DownloadError", "message": f"query/download failed: {exc}"})
            return _write(run_dir, tid, phase="completed", status="succeeded", local_path=str(out.resolve()), error=None)
        if result["status"] == "failed":
            known = vendor_errors.explain(str(result.get("message") or ""), VENDORS[channel]["account"], child.get("model") or "")
            return _write(run_dir, tid, phase="failed", status="failed",
                          error={"type": "VendorError", "message": known[1] if known else f"{VENDORS[channel]['name']}：{result.get('message')}"})
        _write(run_dir, tid, phase="running", status=result.get("raw") or "running", error=None)
        if time.time() >= deadline:
            return _child(run_dir, tid)
        time.sleep(POLL_SECONDS)


def recover(run_dir: Path, tid: str, remote_task_id: str) -> dict:
    """用户从厂商后台抄回来的任务 ID：只记录、之后只查询，不会重新提交。"""
    remote = remote_task_id.strip()
    if not remote or len(remote) > 200:
        raise VendorError("任务 ID 格式不对", kind="invalid_request")
    return _write(run_dir, tid, phase="submitted", status="submitted", jimmy_task_id=remote, error=None,
                  request=_child(run_dir, tid).get("request") or {"recovered": True})
