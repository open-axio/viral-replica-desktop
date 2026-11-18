"""把各家常见的报错翻译成「出了什么事 + 去哪里怎么弄」。认不出来就返回 None，交给调用方的通用说法。"""
from __future__ import annotations

import re

CONSOLE = {
    "火山方舟": "火山方舟控制台「开通管理」",
    "阿里云百炼": "阿里云百炼控制台的「模型广场」",
}


def explain(detail: str, account: str, model: str = "") -> tuple[str, str] | None:
    """返回 (kind, 给用户看的话)。"""
    text = detail or ""
    name = f"「{model}」" if model else "这个模型"
    if re.search(r"ModelNotOpen|has not activated", text, re.I):
        return "auth", f"{account}还没开通{name}：去{CONSOLE.get(account, account + '控制台')}点「开通」（新账号一般有免费额度），开通后回来再点一次"
    if re.search(r"AccessDenied\.Unpurchased|Model\.AccessDenied|not eligible|eligible for using", text, re.I):
        return "auth", f"{account}账户还没开通{name}：去{CONSOLE.get(account, account + '控制台')}开通后再试"
    if re.search(r"Arrearage|InsufficientBalance|insufficient[_ ]balance|余额不足|欠费|\b1008\b", text, re.I):
        return "quota", f"{account}账户余额不够或欠费了：充值后再试"
    if re.search(r"InvalidApiKey|invalid[_ ]api[_ ]key|AuthenticationError|Unauthorized|\b2049\b|\b1004\b", text, re.I):
        return "auth", f"{account}的 Key 不对：检查有没有复制完整，或者在设置里重新粘贴一次"
    if re.search(r"SensitiveContent|DataInspectionFailed|data_inspection|inappropriate|\b1026\b|\b1027\b|敏感", text, re.I):
        return "invalid_request", "参考图或提示词没通过对方的内容审核：换一张参考图，或把描述改得平实一些再试"
    if re.search(r"RateLimit|Throttl|TooManyRequests|rate limit|\b1002\b", text, re.I):
        return "quota", f"{account}说请求太频繁了：等一两分钟再试"
    return None
