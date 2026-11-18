"""Local settings for the console.

Keys live only in ``console.env`` inside the writable data directory (see
``console/paths.py``), or the Jimmy secret file the existing skill already uses. They are never written into project files and are
masked before being sent to the browser.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

from . import paths

# 只读：代码。ROOT 仍指 server.py 所在目录，engine/ 等随代码走。
ROOT = paths.CODE_ROOT
ENGINE_DIR = ROOT / "engine" / "skills"

# 可写：用户数据与运行时，落在应用外部（见 console/paths.py）。
DATA_DIR = paths.DATA_DIR
RUNTIME_DIR = paths.RUNTIME_DIR
ENV_FILE = DATA_DIR / "console.env"
PROJECTS_DIR = DATA_DIR / "projects"
LIBRARY_DIR = DATA_DIR / "library"
BATCHES_DIR = DATA_DIR / "batches"
JIMMY_SCRIPTS = ENGINE_DIR / "jimmy-video-generator" / "scripts"
CHAIN5_SCRIPTS = ENGINE_DIR / "seedance-storyboard-replication" / "scripts"

# Provider slots. All of them speak the OpenAI-compatible /chat/completions API.
# vision：能不能看图。读片子（拆解）要把画面发给模型，看不了图的模型（DeepSeek）只能做写脚本、改台词这类纯文字的步骤。
# None = 不知道（自定义接口），不拦。
PROVIDERS = {
    "openai": {"label": "官方 · OpenAI", "video_native": False, "vision": True},
    "jimmy": {"label": "三方渠道 · GPT-5.6 Sol（共用三方渠道 Key）", "video_native": False, "vision": True},
    "qwen": {"label": "通义千问 Qwen3-VL Plus（阿里云百炼）", "video_native": False, "vision": True},
    "doubao": {"label": "豆包 Seed 2.0 Pro（火山方舟）", "video_native": True, "vision": True},
    "zhipu": {"label": "智谱 GLM-4.6V", "video_native": False, "vision": True},
    "kimi": {"label": "Kimi K2.5（月之暗面）", "video_native": False, "vision": True},
    "deepseek": {"label": "DeepSeek V4 Flash", "video_native": False, "vision": False},
    "ollama": {"label": "本机 · 千问（免费，比云端慢）", "video_native": False, "vision": True},
    "custom": {"label": "自定义（任意 OpenAI 兼容接口）", "video_native": False, "vision": None},
}

DEFAULTS = {
    "OPENAI_API_KEY": "",
    "OPENAI_BASE_URL": "https://api.openai.com/v1",
    "OPENAI_MODEL": "gpt-5.6-sol",
    "OPENAI_IMAGE_MODEL": "gpt-image-2",
    "STORYBOARD_IMAGE_QUALITY": "auto",
    "CAMERA_IMAGE_QUALITY": "auto",
    "OPENAI_REASONING_EFFORT": "",
    "JIMMY_API_KEY": "",
    "DEFAULT_LLM": "jimmy",
    "JIMMY_LLM_MODEL": "gpt-5.6-sol",
    "JIMMY_LLM_BASE_URL": "https://api.viraltok.ai/api/open-api/v1",
    "DOUBAO_BASE_URL": "https://ark.cn-beijing.volces.com/api/v3",
    "DOUBAO_API_KEY": "",
    "DOUBAO_MODEL": "doubao-seed-2-0-pro-260215",
    "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "QWEN_API_KEY": "",
    "QWEN_MODEL": "qwen3-vl-plus",
    "ZHIPU_BASE_URL": "https://open.bigmodel.cn/api/paas/v4",
    "ZHIPU_API_KEY": "",
    "ZHIPU_MODEL": "glm-4.6v",
    "KIMI_BASE_URL": "https://api.moonshot.cn/v1",
    "KIMI_API_KEY": "",
    "KIMI_MODEL": "kimi-k2.5",
    "OLLAMA_BASE_URL": "http://127.0.0.1:11434",
    "OLLAMA_MODEL": "",
    "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
    "DEEPSEEK_API_KEY": "",
    "DEEPSEEK_MODEL": "deepseek-v4-flash",
    "CUSTOM_BASE_URL": "",
    "CUSTOM_API_KEY": "",
    "CUSTOM_MODEL": "",
    "ASR_ENGINE": "auto",
    "ASR_MODEL": "medium",
    "ASR_COMPUTE_TYPE": "int8",
    "ASR_DEVICE": "cpu",
    "ASR_LANGUAGE": "",
    "HF_ENDPOINT": "",
    "MAX_PASSAGES": "14",
    "LLM_PARALLEL": "3",
    "DEEP_FORENSICS": "auto",
    "DEEP_FORENSICS_MAX_SECONDS": "120",
    "SCENE_THRESHOLD": "0.30",
    "MAX_FRAMES": "24",
    "LLM_TIMEOUT": "300",
    "PORT": "8765",
}
# Import after DEFAULTS exists; gateway routing imports config lazily at runtime.
from .gateway.routes import DEFAULT_ROUTES
DEFAULTS.update({'ROUTE_' + step.upper(): route for step, route in DEFAULT_ROUTES.items()})

SECRET_KEYS = {"OPENAI_API_KEY", "JIMMY_API_KEY", "DOUBAO_API_KEY", "DEEPSEEK_API_KEY", "CUSTOM_API_KEY",
               "QWEN_API_KEY", "ZHIPU_API_KEY", "KIMI_API_KEY"}

_lock = threading.Lock()


def _parse(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def _with_defaults(saved: dict[str, str]) -> dict[str, str]:
    """Normalize legacy image choices in memory; reads never migrate the file."""
    merged = {**DEFAULTS, **saved}
    model = merged['OPENAI_IMAGE_MODEL']
    if model and model != DEFAULTS['OPENAI_IMAGE_MODEL']:
        for step in ('STORYBOARD_IMAGE', 'CAMERA_IMAGE'):
            key = 'ROUTE_' + step
            if step + '_QUALITY' not in saved and merged[key] in ('official', 'official:gpt-image-2'):
                merged[key] = 'official:' + model
    return merged


def load() -> dict[str, str]:
    with _lock:
        saved = _parse(ENV_FILE)
        for key in DEFAULTS:
            if os.environ.get(f"VRC_{key}"):
                saved[key] = os.environ[f"VRC_{key}"]
        return _with_defaults(saved)


def get(key: str) -> str:
    return load().get(key, "")


def default_llm() -> str:
    """Choose defaults for new work only; recorded project providers are provenance only."""
    values = load()
    return "openai" if values.get("OPENAI_API_KEY") else values.get("DEFAULT_LLM") or DEFAULTS["DEFAULT_LLM"]


def jimmy_env_file() -> Path:
    """The workbench's own console.env is also the env file handed to the Jimmy skill scripts."""
    return ENV_FILE


def jimmy_configured() -> bool:
    return bool(_parse(ENV_FILE).get("JIMMY_API_KEY"))


def public_view() -> dict:
    values = load()
    view = {}
    for key, value in values.items():
        if key in SECRET_KEYS:
            view[key] = ("已填写 ···" + value[-4:]) if value else ""
        else:
            view[key] = value
    view["_jimmy_configured"] = jimmy_configured()
    from . import gateway
    view["_providers"] = gateway.channels()
    view["_routes"] = gateway.routes.public_routes()
    view["_route_fallback_reason"] = '' if values.get('OPENAI_API_KEY') else '官方 Key 未配置，官方默认路由暂时使用现有三方渠道 / DeepSeek 配置。'
    return view


def save(updates: dict[str, str]) -> None:
    """Persist edits. Secret fields left blank or masked keep their old value."""
    with _lock:
        current = _with_defaults(_parse(ENV_FILE))
        for key, value in updates.items():
            if key not in DEFAULTS:
                continue
            value = str(value).strip()
            if key in SECRET_KEYS and (not value or value.startswith("已填写")):
                continue
            if "\n" in value:
                raise ValueError(f"{key} 不能包含换行")
            current[key] = value
        from .gateway import routes
        routes.validate(current)
        lines = ["# 爆款复刻工作台本地配置（不要分享这个文件）"]
        lines += [f"{key}={current[key]}" for key in DEFAULTS]
        # keep any extra lines written by install scripts (e.g. HF_ENDPOINT) that are also DEFAULTS keys
        tmp = ENV_FILE.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(ENV_FILE)


def provider_settings(name: str) -> dict[str, str]:
    if name not in PROVIDERS:
        raise ValueError(f"未知模型渠道：{name}")
    values = load()
    if name == "ollama":
        model = values.get("OLLAMA_MODEL", "")
        if not model:
            raise ValueError("还没装本机模型：在「设置 → 本机模型」里下载一个")
        # 本机不需要 Key；本机模型慢，超时放宽到至少 30 分钟
        return {"name": name, "base_url": (values.get("OLLAMA_BASE_URL") or DEFAULTS["OLLAMA_BASE_URL"]).rstrip("/"),
                "api_key": "ollama", "model": model,
                "timeout": max(float(values.get("LLM_TIMEOUT") or 300), 1800.0)}
    if name == "jimmy":
        key = _parse(ENV_FILE).get("JIMMY_API_KEY", "")
        if not key:
            raise ValueError("还没填三方渠道 Key：点右上角“设置”，在三方渠道栏填写")
        return {"name": name, "base_url": (values.get("JIMMY_LLM_BASE_URL") or "https://api.viraltok.ai/api/open-api/v1").rstrip("/"),
                "api_key": key,
                "model": values.get("JIMMY_LLM_MODEL") or DEFAULTS["JIMMY_LLM_MODEL"],
                "timeout": float(values.get("LLM_TIMEOUT") or 300)}
    prefix = name.upper()
    settings = {
        "name": name,
        "base_url": values.get(f"{prefix}_BASE_URL", "").rstrip("/"),
        "api_key": values.get(f"{prefix}_API_KEY", ""),
        "model": values.get(f"{prefix}_MODEL", ""),
        "timeout": float(values.get("LLM_TIMEOUT") or 300),
    }
    missing = [k for k in ("base_url", "api_key", "model") if not settings[k]]
    if missing:
        raise ValueError(f"模型渠道「{PROVIDERS[name]['label']}」还没配置：{', '.join(missing)}（在“设置”里填写）")
    if name == "openai":
        settings["reasoning_effort"] = values.get("OPENAI_REASONING_EFFORT", "").strip()
    return settings
