"""本机 Ollama：走它自己的 /api/chat，而不是 OpenAI 兼容口。

原因：OpenAI 兼容口没法设上下文长度，Ollama 默认只开几千个 token，读片子时台词、帧网格一多就被
悄悄截断。这里把 OpenAI 格式的消息（文字 + data URL 图片）换成 Ollama 的格式，返回值再换回 OpenAI
的 choices/usage 形状，后面的解析和用量记录都不用改。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from ..errors import LLMError

NUM_CTX = 16384


def to_ollama(messages: list[dict]) -> list[dict]:
    out = []
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            texts, images = [], []
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text":
                    texts.append(part.get("text") or "")
                elif part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url") or ""
                    if url.startswith("data:") and "," in url:
                        images.append(url.split(",", 1)[1])
            msg = {"role": m.get("role", "user"), "content": "\n".join(texts)}
            if images:
                msg["images"] = images
            out.append(msg)
        else:
            out.append({"role": m.get("role", "user"), "content": content or ""})
    return out


def chat(settings: dict, messages: list[dict], *, temperature: float, max_tokens: int) -> dict:
    body = {"model": settings["model"], "messages": to_ollama(messages), "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens, "num_ctx": NUM_CTX}}
    base = settings["base_url"].rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    req = urllib.request.Request(base + "/api/chat", data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 本机地址不走代理
    try:
        with opener.open(req, timeout=settings["timeout"]) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        if "not found" in detail:
            raise LLMError(f"本机还没有模型 {settings['model']}：到设置里「本机模型」下载", kind="invalid_request") from None
        raise LLMError(f"本机模型出错：{detail}", kind="transient") from None
    except (urllib.error.URLError, ConnectionError, OSError) as exc:
        if "timed out" in str(exc):
            raise LLMError("本机模型太慢，超时了。这一步可以换成云端模型，或者换小一点的本机模型", kind="unknown") from None
        raise LLMError("连不上本机的 Ollama：确认 Ollama 已经打开（电脑右下角/菜单栏有它的图标）", kind="unknown") from None
    if data.get("error"):
        raise LLMError(f"本机模型出错：{data['error']}", kind="transient")
    msg = data.get("message") or {}
    return {
        "choices": [{"message": {"content": msg.get("content") or ""},
                     "finish_reason": "length" if data.get("done_reason") == "length" else "stop"}],
        "usage": {"prompt_tokens": data.get("prompt_eval_count"), "completion_tokens": data.get("eval_count")},
        "model": data.get("model") or settings["model"],
    }
