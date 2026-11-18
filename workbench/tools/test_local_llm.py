"""电脑体检、本机千问（Ollama）：按硬件推荐档位、下载进度、登记成推理渠道、消息格式转换。"""
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from console import config, gateway, local_llm  # noqa: E402
from console.gateway import reasoning  # noqa: E402
from console.gateway.adapters import ollama  # noqa: E402


class FakeOpener:
    """代替 urllib 的 opener：按路径返回预设的响应，并记下请求。"""

    def __init__(self, routes):
        self.routes, self.seen = routes, []

    def open(self, req, timeout=None):
        url = req if isinstance(req, str) else req.full_url
        path = url.split("11434", 1)[-1]
        body = None if isinstance(req, str) or req.data is None else json.loads(req.data)
        self.seen.append((path, body))
        out = self.routes.get(path)
        if out is None:
            raise OSError("connection refused")
        if isinstance(out, list):
            return io.BytesIO(b"\n".join(json.dumps(x).encode() for x in out))
        return io.BytesIO(json.dumps(out).encode())


class LocalLlmTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.enterContext(patch.object(config, "ENV_FILE", tmp / "local-llm-test.env"))
        # 默认当作本机没开 Ollama；离线测试不允许真的连端口，也不读真实硬件
        self.enterContext(patch.object(local_llm, "_opener", return_value=FakeOpener({})))
        self.enterContext(patch.object(local_llm, "hardware", return_value={"gpu": None, "ram_gb": 16}))
        local_llm._pull.clear()

    def test_recommendation_by_hardware(self):
        r = local_llm.recommend
        self.assertEqual(r({"gpu": {"name": "NVIDIA GeForce GTX 1080", "vram_gb": 8.0}, "ram_gb": 16})["model"], "qwen3.5:9b")
        self.assertEqual(r({"gpu": {"vram_gb": 6}, "ram_gb": 8})["model"], "qwen3.5:4b")
        self.assertEqual(r({"gpu": None, "ram_gb": 16})["model"], "qwen3.5:4b")
        self.assertIn("CPU", r({"gpu": None, "ram_gb": 16})["speed"])
        self.assertIsNone(r({"gpu": None, "ram_gb": 8})["model"])
        self.assertEqual(r({"apple_silicon": True, "ram_gb": 16})["model"], "qwen3.5:9b")
        self.assertIn("不够", r({"gpu": {"vram_gb": 8}, "ram_gb": 16})["video"])
        self.assertIn("够用", r({"gpu": {"vram_gb": 24}, "ram_gb": 64})["video"])

    def test_status_when_ollama_is_not_running(self):
        with patch.object(local_llm, "_opener", return_value=FakeOpener({})), \
                patch.object(local_llm, "hardware", return_value={"gpu": None, "ram_gb": 16}):
            st = local_llm.status()
        self.assertFalse(st["ollama"]["running"])
        self.assertEqual(st["download_url"], "https://ollama.com/download")
        with patch.object(local_llm, "_opener", return_value=FakeOpener({})), self.assertRaisesRegex(ValueError, "Ollama 还没启动"):
            local_llm.pull("qwen3.5:9b")

    def test_pull_reports_progress_and_finishes(self):
        fake = FakeOpener({"/api/version": {"version": "0.12"}, "/api/tags": {"models": []},
                           "/api/pull": [{"status": "pulling manifest"}, {"status": "downloading", "total": 100, "completed": 40},
                                         {"status": "downloading", "total": 100, "completed": 100}, {"status": "success"}]})
        with patch.object(local_llm, "_opener", return_value=fake), \
                patch.object(local_llm, "hardware", return_value={"gpu": None, "ram_gb": 16}), \
                patch("threading.Thread") as thread:
            local_llm.pull("qwen3.5:9b")
            target = thread.call_args.kwargs["target"]
            target(*thread.call_args.kwargs["args"])
        self.assertEqual(local_llm._pull["state"], "done")
        self.assertEqual(local_llm._pull["completed"], 100)
        self.assertEqual(fake.seen[-1], ("/api/pull", {"model": "qwen3.5:9b", "stream": True}))
        with self.assertRaisesRegex(ValueError, "不认识"):
            local_llm.pull("evil; rm -rf")

    def test_use_registers_channel_for_text_steps_only_by_default(self):
        self.assertFalse(gateway.channels()["ollama"]["ready"])
        local_llm.use("qwen3.5:9b")
        values = config.load()
        self.assertEqual((values["OLLAMA_MODEL"], values["ROUTE_SCRIPT"]), ("qwen3.5:9b", "ollama"))
        self.assertNotEqual(values.get("ROUTE_ANALYSIS"), "ollama")
        self.assertTrue(gateway.channels()["ollama"]["ready"])
        local_llm.use("qwen3.5:9b", "all")
        self.assertEqual(config.load()["ROUTE_ANALYSIS"], "ollama")
        settings = config.provider_settings("ollama")
        self.assertGreaterEqual(settings["timeout"], 1800)

    def test_messages_become_ollama_native_with_images_and_big_context(self):
        msgs = [{"role": "system", "content": "只回 JSON"},
                {"role": "user", "content": [{"type": "text", "text": "看图"},
                                             {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,QUJD"}}]}]
        self.assertEqual(ollama.to_ollama(msgs)[1], {"role": "user", "content": "看图", "images": ["QUJD"]})
        fake = FakeOpener({"/api/chat": {"model": "qwen3.5:9b", "message": {"content": "{\"ok\": 1}"},
                                         "prompt_eval_count": 900, "eval_count": 12, "done_reason": "stop"}})
        local_llm.use("qwen3.5:9b")
        with patch("urllib.request.build_opener", return_value=fake):
            out = reasoning.chat("ollama", msgs, max_tokens=500)
        path, body = fake.seen[0]
        self.assertEqual(path, "/api/chat")
        self.assertEqual(body["options"]["num_ctx"], ollama.NUM_CTX)
        self.assertEqual(body["options"]["num_predict"], 500)
        self.assertEqual(json.loads(out["content"]), {"ok": 1})

    def test_friendly_error_when_ollama_closed(self):
        local_llm.use("qwen3.5:9b")
        with patch("urllib.request.build_opener", return_value=FakeOpener({})), \
                self.assertRaisesRegex(Exception, "连不上本机的 Ollama"):
            reasoning.chat("ollama", [{"role": "user", "content": "hi"}])


if __name__ == "__main__":
    unittest.main()
