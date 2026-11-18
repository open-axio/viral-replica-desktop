"""更多生图厂商：「参考图 + 提示词 → 一张图」，同步出图，和官方 OpenAI 生图走同一套预览 → 确认 → 保存流程。

- ark：火山方舟 Seedream（和豆包用同一个火山方舟 Key）。POST {DOUBAO_BASE_URL}/images/generations，
  image 传参考图数组，同步返回。
- bailian：阿里云百炼 千问图像编辑（和千问用同一个百炼 Key）。POST {base}/api/v1/services/aigc/
  multimodal-generation/generation，最多 3 张参考图，同步返回图片链接（24 小时有效，立即下载）。
- imgcompat：任意 OpenAI 兼容的生图接口（/images/edits），很多聚合平台都能这样接。

确认后只发一次请求、不自动重试：网络断开时可能已经计费，交给用户看结果再决定。
"""
from __future__ import annotations

import base64
import json
import math
import mimetypes
import urllib.error
import urllib.request
from pathlib import Path

from ... import config, llm, store
from ..errors import ImageError
from . import vendor_errors

VENDORS = {
    "ark": {
        "name": "火山方舟 Seedream", "account": "火山方舟", "key": "DOUBAO_API_KEY", "key_channel": "doubao", "max_refs": 10,
        "models": [
            {"id": "doubao-seedream-4-5-251128", "name": "Seedream 4.5", "note": "推荐：画质好，最多 10 张参考图"},
            {"id": "doubao-seedream-4-0-250828", "name": "Seedream 4.0", "note": "上一代，便宜一些"},
        ],
    },
    "bailian": {
        "name": "阿里云百炼 图像编辑", "account": "阿里云百炼", "key": "QWEN_API_KEY", "key_channel": "qwen", "max_refs": 9,
        "models": [
            {"id": "wan2.7-image-pro", "name": "万相 2.7 图像 Pro", "note": "推荐：最多 9 张参考图，人物和商品更稳", "max_refs": 9},
            {"id": "wan2.7-image", "name": "万相 2.7 图像", "note": "更快更便宜，最多 9 张参考图", "max_refs": 9},
            {"id": "qwen-image-edit-plus", "name": "千问图像编辑 Plus", "note": "最多 3 张参考图", "max_refs": 3},
            {"id": "qwen-image-2.0-pro", "name": "千问图像 2.0 Pro", "note": "文字和质感更好，最多 3 张参考图", "max_refs": 3},
        ],
    },
    "imgcompat": {
        "name": "OpenAI 兼容生图接口", "account": "这个接口", "key": "IMGCOMPAT_API_KEY", "key_channel": "imgcompat", "max_refs": 10,
        "models": [],
    },
}

# 宽:高 → 各家要求的尺寸写法。Seedream 要求总像素在 720p 到 4K 之间；千问图像编辑在 512² 到 2048² 之间。
_ARK_SIZES = [("1440x2560", 9 / 16), ("1728x2304", 3 / 4), ("2048x2048", 1.0), ("2304x1728", 4 / 3), ("2560x1440", 16 / 9)]
_BAILIAN_SIZES = [("1080*1920", 9 / 16), ("1248*1664", 3 / 4), ("1536*1536", 1.0), ("1664*1248", 4 / 3), ("1920*1080", 16 / 9)]


def is_vendor(channel: str | None) -> bool:
    return channel in VENDORS


def default_model(channel: str) -> str:
    if channel == "imgcompat":
        return config.load().get("IMGCOMPAT_MODEL") or ""
    return VENDORS[channel]["models"][0]["id"]


def max_refs(channel: str, model: str | None = None) -> int:
    """每个模型能收的参考图不一样（千问图像编辑只收 3 张）。"""
    found = next((m for m in VENDORS[channel]["models"] if m["id"] == (model or default_model(channel))), None)
    return (found or {}).get("max_refs") or VENDORS[channel]["max_refs"]


def size_for(channel: str, ratio: str) -> str:
    try:
        w, h = map(float, str(ratio).split(":"))
        value = w / h
        if not math.isfinite(value) or value <= 0:
            raise ValueError
    except (ValueError, ZeroDivisionError):
        raise ImageError("生图比例无效，请使用宽:高格式", kind="invalid_request", channel=channel) from None
    if channel == "imgcompat":
        from .official import image_size
        return image_size(ratio)
    table = _ARK_SIZES if channel == "ark" else _BAILIAN_SIZES
    return min(table, key=lambda item: abs(item[1] - value))[0]


def _settings(channel: str) -> dict:
    values = config.load()
    meta = VENDORS[channel]
    key = (values.get(meta["key"]) or "").strip()
    if not key:
        raise ImageError(f"还没填{meta['account']}的 Key：在「设置 → 生图模型」里填好再试", kind="auth", channel=channel)
    if channel == "ark":
        base = (values.get("DOUBAO_BASE_URL") or config.DEFAULTS["DOUBAO_BASE_URL"]).rstrip("/")
    elif channel == "bailian":
        compat = (values.get("QWEN_BASE_URL") or config.DEFAULTS["QWEN_BASE_URL"]).rstrip("/")
        base = compat.replace("/compatible-mode/v1", "/api/v1") if "/compatible-mode/" in compat else "https://dashscope.aliyuncs.com/api/v1"
    else:
        base = (values.get("IMGCOMPAT_BASE_URL") or "").rstrip("/")
        if not base:
            raise ImageError("OpenAI 兼容生图接口还没填地址：在「设置 → 高级设置」里填", kind="invalid_request", channel=channel)
    return {"key": key, "base": base}


def _data_uri(ref: dict) -> str:
    path = Path(ref["path"])
    content = path.read_bytes()
    if ref.get("sha256") and store.sha256_file(path) != ref["sha256"]:
        raise ImageError("参考图在确认后被改动，请重新生成预览", kind="invalid_request")
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64," + base64.b64encode(content).decode("ascii")


def _post_json(url: str, body: dict, key: str, channel: str, model: str) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    return _send(req, channel, model)


def _send(req, channel: str, model: str) -> dict:
    name = VENDORS[channel]["name"]
    try:
        from ..usage import mark_network_request
        mark_network_request()
        with urllib.request.urlopen(req, timeout=300, context=llm._ssl_context()) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        exc.close()
        kind = "auth" if exc.code in (401, 403) else "quota" if exc.code == 429 else "invalid_request" if exc.code == 400 else "transient"
        known = vendor_errors.explain(detail, VENDORS[channel]["account"], model)
        if known:
            raise ImageError(known[1], kind=known[0], channel=channel, model=model, technical=detail) from None
        hint = {"auth": "Key 不对或没开通这个模型", "quota": "额度不够或请求太频繁", "invalid_request": "请求被拒绝（可能是参考图或提示词没通过审核）"}.get(kind, "服务暂时出错")
        raise ImageError(f"{name}：{hint}。{_brief(detail)}", kind=kind, channel=channel, model=model, technical=detail) from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise ImageError(f"{name}的请求没完成，可能已经计费：先看看素材库有没有结果，再决定要不要重试",
                         kind="transient", channel=channel, model=model) from exc


def _brief(detail: str) -> str:
    try:
        data = json.loads(detail)
        err = data.get("error") if isinstance(data.get("error"), dict) else data
        return str(err.get("message") or err.get("msg") or "")[:200]
    except (ValueError, AttributeError):
        return ""


def _download(url: str, channel: str, model: str) -> bytes:
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=300, context=llm._ssl_context()) as resp:
            return resp.read()
    except (urllib.error.URLError, OSError) as exc:
        raise ImageError(f"{VENDORS[channel]['name']}已出图，但下载图片失败：检查网络后在素材库里点「恢复」",
                         kind="transient", channel=channel, model=model) from exc


def generate(channel: str, preview: dict, output: Path, *, before_send=None) -> dict:
    """按预览发一次请求，把图片写到 output。返回 {output_sha256, usage}。"""
    model = preview.get("model") or default_model(channel)
    s = _settings(channel)
    if before_send:
        before_send()
    refs = preview.get("images") or []
    if len(refs) > max_refs(channel, model):
        raise ImageError(f"{VENDORS[channel]['name']}的这个模型最多支持 {max_refs(channel, model)} 张参考图，这次有 {len(refs)} 张：减少参考图或换一个生图模型",
                         kind="invalid_request", channel=channel, model=model)
    size = preview.get("size") or size_for(channel, preview.get("ratio") or "9:16")
    if channel == "ark":
        body = {"model": model, "prompt": preview["prompt"], "size": size, "response_format": "b64_json",
                "watermark": False, "sequential_image_generation": "disabled"}
        if refs:
            body["image"] = [_data_uri(r) for r in refs]
        data = _post_json(s["base"] + "/images/generations", body, s["key"], channel, model)
        content = _first_image(data, channel, model)
    elif channel == "bailian":
        content_parts = [{"image": _data_uri(r)} for r in refs] + [{"text": preview["prompt"]}]
        body = {"model": model, "input": {"messages": [{"role": "user", "content": content_parts}]},
                "parameters": {"n": 1, "size": size, "watermark": False,
                               # 千问图像默认会改写提示词，关掉以免改掉人物和商品；万相 2.7 没有这个参数
                               **({"prompt_extend": False} if model.startswith("qwen-image") else {})}}
        data = _post_json(s["base"] + "/services/aigc/multimodal-generation/generation", body, s["key"], channel, model)
        if data.get("code") and not data.get("output"):
            known = vendor_errors.explain(f"{data.get('code')} {data.get('message')}", "阿里云百炼", model)
            raise ImageError(known[1] if known else f"阿里云百炼：{data.get('message') or data.get('code')}",
                             kind=known[0] if known else "invalid_request", channel=channel, model=model,
                             technical=json.dumps(data, ensure_ascii=False)[:600])
        try:
            parts = data["output"]["choices"][0]["message"]["content"]
            url = next(p["image"] for p in parts if isinstance(p, dict) and p.get("image"))
        except (KeyError, IndexError, TypeError, StopIteration):
            raise ImageError("阿里云百炼已响应，但没有返回图片", kind="empty", channel=channel, model=model,
                             technical=json.dumps(data, ensure_ascii=False)[:600]) from None
        content = _download(url, channel, model)
    else:
        from ... import openai_image
        multipart, content_type = openai_image._multipart({**preview, "model": model})
        req = urllib.request.Request(s["base"] + "/images/edits", data=multipart, method="POST",
                                     headers={"Content-Type": content_type, "Authorization": "Bearer " + s["key"]})
        data = _send(req, channel, model)
        content = _first_image(data, channel, model)
    if not content:
        raise ImageError(f"{VENDORS[channel]['name']}返回了空图片", kind="empty", channel=channel, model=model)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(".tmp")
    temp.write_bytes(content)
    temp.replace(output)
    return {"output_sha256": store.sha256_file(output), "usage": data.get("usage") or {}, "model": model}


def _first_image(data: dict, channel: str, model: str) -> bytes:
    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        raise ImageError(f"{VENDORS[channel]['name']}：{(err.get('message') if isinstance(err, dict) else err) or '返回错误'}",
                         kind="invalid_request", channel=channel, model=model, technical=json.dumps(data, ensure_ascii=False)[:600])
    try:
        item = data["data"][0]
        if item.get("b64_json"):
            return base64.b64decode(item["b64_json"], validate=True)
        if item.get("url"):
            return _download(item["url"], channel, model)
    except (KeyError, IndexError, TypeError, ValueError):
        pass
    raise ImageError(f"{VENDORS[channel]['name']}已响应，但没有返回图片", kind="empty", channel=channel, model=model,
                     technical=json.dumps(data, ensure_ascii=False)[:600] if isinstance(data, dict) else "")
