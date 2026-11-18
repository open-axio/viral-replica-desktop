"""新增的推理渠道：通义千问、智谱、Kimi、DeepSeek 官方；看不了图的模型不能拿来读片子。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from console import config, gateway  # noqa: E402
from console.gateway import reasoning  # noqa: E402
from console.gateway.errors import LLMError  # noqa: E402

IMG = [{"role": "user", "content": [{"type": "text", "text": "看图"},
                                     {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}}]}]


class ProviderTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.enterContext(patch.object(config, "ENV_FILE", tmp / "providers-test.env"))  # 离线测试禁止写名叫 console.env 的文件

    def test_connection_says_model_not_activated_instead_of_bad_key(self):
        import io
        import urllib.error
        config.save({"DOUBAO_API_KEY": "ark-key"})
        body = b'{"error":{"code":"ModelNotOpen","message":"Your account 1 has not activated the model doubao-seed-2-0-pro-260215."}}'

        def boom(*a, **k):
            raise urllib.error.HTTPError("u", 404, "Not Found", {}, io.BytesIO(body))
        with patch("urllib.request.urlopen", side_effect=boom), patch("time.sleep"):
            result = gateway.test_connection("doubao")
        self.assertEqual(result["status"], "模型没开通")
        self.assertIn("开通管理", result["detail"])

    def test_new_providers_have_defaults_and_secret_keys(self):
        for name, base in (("qwen", "dashscope.aliyuncs.com"), ("zhipu", "open.bigmodel.cn"), ("kimi", "api.moonshot.cn"),
                           ("deepseek", "api.deepseek.com")):
            self.assertIn(name, config.PROVIDERS)
            self.assertIn(base, config.DEFAULTS[name.upper() + "_BASE_URL"])
            self.assertTrue(config.DEFAULTS[name.upper() + "_MODEL"])
            self.assertIn(name.upper() + "_API_KEY", config.SECRET_KEYS)
        self.assertFalse(config.PROVIDERS["deepseek"]["vision"])
        self.assertTrue(config.PROVIDERS["qwen"]["vision"])

    def test_saved_key_is_masked_and_channel_becomes_ready(self):
        self.assertFalse(gateway.channels()["qwen"]["ready"])
        config.save({"QWEN_API_KEY": "sk-qwen-123456"})
        self.assertEqual(config.public_view()["QWEN_API_KEY"], "已填写 ···3456")
        self.assertTrue(gateway.channels()["qwen"]["ready"])
        self.assertEqual(gateway.channels()["qwen"]["label"], "阿里云百炼 · 千问 3.6 Plus")

    def test_route_can_pick_new_providers(self):
        for name in ("qwen", "zhipu", "kimi", "deepseek"):
            self.assertEqual(gateway.routes.parse(name, "analysis")["channel"], name)

    def test_text_only_model_is_refused_for_pictures_before_any_request(self):
        settings = {"name": "deepseek", "base_url": config.DEFAULTS["DEEPSEEK_BASE_URL"], "api_key": "k", "model": "m", "timeout": 1}
        with patch.object(config, "provider_settings", lambda n: settings), \
                patch("console.llm._post", side_effect=AssertionError("不该发请求")), \
                self.assertRaisesRegex(LLMError, "看不了图"):
            reasoning.chat("deepseek", IMG)
        # 改过地址（比如走 OpenRouter）就不确定背后的模型，不拦
        other = {**settings, "base_url": "https://openrouter.ai/api/v1"}
        with patch.object(config, "provider_settings", lambda n: other), \
                patch("console.llm._post", side_effect=RuntimeError("已发出请求")), \
                self.assertRaisesRegex(Exception, "已发出请求"):
            reasoning.chat("deepseek", IMG)

    def test_qwen_request_goes_to_its_openai_compatible_endpoint(self):
        import io
        captured = []

        def send(req, **kw):
            captured.append((req.full_url, req.headers.get("Authorization"), json.loads(req.data)["model"]))
            return io.BytesIO(json.dumps({"choices": [{"message": {"content": "OK"}, "finish_reason": "stop"}],
                                          "usage": {"prompt_tokens": 3, "completion_tokens": 1}}).encode())
        config.save({"QWEN_API_KEY": "sk-q"})
        with patch("urllib.request.urlopen", side_effect=send):
            out = reasoning.chat("qwen", IMG, max_tokens=50)
        self.assertIn("OK", json.dumps(out, ensure_ascii=False))
        self.assertEqual(captured, [("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", "Bearer sk-q", "qwen3.6-plus")])

    def test_one_key_many_models_with_per_model_vision(self):
        cat = config.MODEL_CATALOG
        self.assertGreaterEqual(len(cat["qwen"]), 3, "百炼一个 Key 要有多个模型可选")
        self.assertGreaterEqual(len(cat["doubao"]), 3)
        for vendor, models in cat.items():
            self.assertIn(vendor, config.PROVIDERS)
            self.assertEqual(len({m["id"] for m in models}), len(models), vendor)
        # 同一个百炼 Key：千问能看图，百炼托管的 DeepSeek 只能文字
        self.assertTrue(config.model_vision("qwen", "qwen3.6-plus"))
        self.assertFalse(config.model_vision("qwen", "deepseek-v3.2"))
        self.assertIsNone(config.model_vision("custom", "whatever"))
        settings = {"name": "qwen", "base_url": "https://my-proxy.example/v1", "api_key": "k", "model": "deepseek-v3.2", "timeout": 1}
        with patch.object(config, "provider_settings", lambda n: settings), self.assertRaisesRegex(LLMError, "DeepSeek V3.2.*看不了图"):
            reasoning.chat("qwen", IMG)
        # 路由里带模型名：同一个厂商、不同步骤用不同模型
        self.assertEqual(gateway.routes.parse("qwen:qwen3.6-flash", "script"), {"channel": "qwen", "model": "qwen3.6-flash"})
        self.assertEqual(gateway.label("doubao", "doubao-seed-2-0-lite-260215"), "豆包 Seed 2.0 Lite")
        self.assertIn("_catalog", config.public_view())


if __name__ == "__main__":
    unittest.main()
