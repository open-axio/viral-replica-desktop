"""新接的生图厂商：火山方舟 Seedream、阿里云百炼千问图像编辑、OpenAI 兼容接口。只测请求格式和结果处理（不联网）。"""
import base64
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from console import config, jimmy_bridge, store  # noqa: E402
from console.gateway import routes  # noqa: E402
from console.gateway.adapters import image_vendors  # noqa: E402
from console.gateway.errors import ImageError  # noqa: E402

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.enterContext(patch.object(config, "ENV_FILE", self.tmp / "image-vendors-test.env"))
        self.refs = []
        for i in range(2):
            f = self.tmp / f"ref{i}.png"
            f.write_bytes(PNG)
            self.refs.append({"source": "file", "path": str(f), "sha256": store.sha256_file(f)})
        self.sent = []

    def preview(self, channel, **kw):
        return {"model": "", "prompt": "图1的人拿着图2的杯子", "ratio": "9:16", "channel": channel,
                "size": image_vendors.size_for(channel, "9:16"), "images": self.refs, **kw}

    def fake(self, *replies):
        replies = list(replies)

        def urlopen(req, timeout=None, context=None):
            self.sent.append(req)
            out = replies.pop(0)
            if isinstance(out, Exception):
                raise out
            return Reply(out if isinstance(out, bytes) else json.dumps(out).encode())
        return patch("urllib.request.urlopen", side_effect=urlopen)



class ImageVendorTests(Base):
    def test_ark_seedream_sends_all_references_and_saves_b64(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        out = self.tmp / "out.png"
        with self.fake({"data": [{"b64_json": base64.b64encode(PNG).decode()}], "usage": {"generated_images": 1}}):
            result = image_vendors.generate("ark", self.preview("ark"), out)
        req = self.sent[0]
        body = json.loads(req.data)
        self.assertEqual(req.full_url, "https://ark.cn-beijing.volces.com/api/v3/images/generations")
        self.assertEqual(req.headers["Authorization"], "Bearer ark-key")
        self.assertEqual(body["model"], "doubao-seedream-4-5-251128")
        self.assertEqual(len(body["image"]), 2)
        self.assertTrue(body["image"][0].startswith("data:image/png;base64,"))
        self.assertEqual((body["size"], body["watermark"], body["response_format"]), ("1440x2560", False, "b64_json"))
        self.assertEqual(out.read_bytes(), PNG)
        self.assertEqual(result["output_sha256"], store.sha256_file(out))

    def test_bailian_puts_images_before_text_and_downloads_url(self):
        config.save({"QWEN_API_KEY": "bl-key"})
        out = self.tmp / "out.png"
        reply = {"output": {"choices": [{"message": {"content": [{"image": "https://dashscope-result.example/x.png"}]}}]},
                 "usage": {"image_count": 1}}
        with self.fake(reply, PNG):
            image_vendors.generate("bailian", self.preview("bailian"), out)
        req, download = self.sent
        body = json.loads(req.data)
        self.assertEqual(req.full_url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation")
        parts = body["input"]["messages"][0]["content"]
        self.assertEqual([list(p) for p in parts], [["image"], ["image"], ["text"]])
        self.assertEqual((body["model"], body["parameters"]["size"]), ("wan2.7-image-pro", "1080*1920"))
        self.assertNotIn("prompt_extend", body["parameters"], "万相 2.7 图像没有这个参数")
        self.assertNotIn("Authorization", download.headers, "下载图片不能带上 Key")
        self.assertEqual(out.read_bytes(), PNG)

    def test_reference_limit_depends_on_model(self):
        config.save({"QWEN_API_KEY": "bl-key"})
        prev = self.preview("bailian", images=self.refs * 2, model="qwen-image-edit-plus")
        with self.fake(), self.assertRaisesRegex(ImageError, "最多支持 3 张"):
            image_vendors.generate("bailian", prev, self.tmp / "o.png")
        self.assertEqual(self.sent, [], "超过张数不能发请求")
        self.assertEqual(jimmy_bridge.max_image_references("bailian", "qwen-image-edit-plus"), 3)
        self.assertEqual(jimmy_bridge.max_image_references("bailian"), 9, "默认的万相 2.7 图像收 9 张")
        self.assertEqual(jimmy_bridge.max_image_references("ark"), 10)

    def test_missing_key_and_auth_error_are_plain_language(self):
        with self.assertRaisesRegex(ImageError, "还没填火山方舟的 Key"):
            image_vendors.generate("ark", self.preview("ark"), self.tmp / "o.png")
        config.save({"DOUBAO_API_KEY": "bad"})
        err = urllib.error.HTTPError("u", 401, "Unauthorized", {}, io.BytesIO(b'{"error":{"message":"invalid api key"}}'))
        with self.fake(err), self.assertRaises(ImageError) as ctx:
            image_vendors.generate("ark", self.preview("ark"), self.tmp / "o.png")
        self.assertEqual(ctx.exception.kind, "auth")
        self.assertIn("Key 不对", ctx.exception.message)

    def test_bailian_unpurchased_and_arrearage_are_plain_language(self):
        config.save({"QWEN_API_KEY": "bl-key"})
        with self.fake({"code": "AccessDenied.Unpurchased", "message": "Access to model denied."}), self.assertRaises(ImageError) as ctx:
            image_vendors.generate("bailian", self.preview("bailian"), self.tmp / "o.png")
        self.assertIn("还没开通", ctx.exception.message)
        err = urllib.error.HTTPError("u", 400, "Bad", {}, io.BytesIO(b'{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}'))
        with self.fake(err), self.assertRaises(ImageError) as ctx:
            image_vendors.generate("bailian", self.preview("bailian"), self.tmp / "o.png")
        self.assertEqual(ctx.exception.kind, "quota")
        self.assertIn("充值", ctx.exception.message)

    def test_compat_endpoint_uses_edits_with_its_own_key(self):
        config.save({"IMGCOMPAT_API_KEY": "c-key", "IMGCOMPAT_BASE_URL": "https://agg.example/v1/", "IMGCOMPAT_MODEL": "nano-image"})
        out = self.tmp / "out.png"
        with self.fake({"data": [{"b64_json": base64.b64encode(PNG).decode()}]}):
            image_vendors.generate("imgcompat", self.preview("imgcompat", model="nano-image", size="1024x1536"), out)
        req = self.sent[0]
        self.assertEqual(req.full_url, "https://agg.example/v1/images/edits")
        self.assertIn(b'name="model"\r\n\r\nnano-image', req.data)
        self.assertEqual(out.read_bytes(), PNG)

    def test_routes_accept_vendor_channels_with_default_models(self):
        self.assertEqual(routes.parse("ark", "storyboard_image"), {"channel": "ark", "model": "doubao-seedream-4-5-251128"})
        self.assertEqual(routes.parse("bailian:qwen-image-2.0-pro", "camera_image")["model"], "qwen-image-2.0-pro")
        with self.assertRaises(ValueError):
            routes.parse("imgcompat", "video")
        self.assertTrue(jimmy_bridge._direct_image("ark"))
        self.assertFalse(jimmy_bridge._direct_image("third_party"))


class BridgeFlowTests(Base):
    """真实项目里走一遍：预览（不花钱）→ 确认（发一次请求）→ 图片进素材库。"""

    def test_preview_confirm_saves_asset(self):
        import threading
        import time
        from console import jobs, pipeline
        projects = self.tmp / "proj-test"; projects.mkdir()
        self.enterContext(patch.object(config, "PROJECTS_DIR", projects))
        config.save({"DOUBAO_API_KEY": "ark-key"})
        pid = store.create("生图厂商")["id"]
        src = self.tmp / "person.png"; src.write_bytes(PNG)
        aid = pipeline.save_asset(pid, "person.png", src, "image", "人物", ["character"])["id"]
        from console import gateway
        rec = gateway.image_preview("storyboard_image", pid, "把图1的人放进咖啡店", [aid], "9:16", None, "2k", None,
                                    override="ark:doubao-seedream-4-0-250828")
        self.assertEqual((rec["channel"], rec["state"]), ("ark", "pending_confirmation"))
        self.assertIn("火山方舟", rec["summary"])
        self.assertEqual(rec["preview"]["model"], "doubao-seedream-4-0-250828")
        with self.fake({"data": [{"b64_json": base64.b64encode(PNG).decode()}]}):
            gateway.image_confirm(pid, rec["id"])
            for _ in range(100):
                if jobs.snapshot(pid).get(f"img:{rec['id']}", {}).get("state") != "running":
                    break
                time.sleep(0.05)
        done = store.load(pid)["images"][rec["id"]]
        self.assertEqual(done["state"], "completed", done.get("error"))
        self.assertTrue(any(a.get("file", "").startswith("assets/" + rec["id"]) for a in store.load(pid)["assets"]))
        self.assertEqual(len(self.sent), 1, "确认只发一次请求")
        self.assertEqual(json.loads(self.sent[0].data)["model"], "doubao-seedream-4-0-250828")


if __name__ == "__main__":
    unittest.main()
