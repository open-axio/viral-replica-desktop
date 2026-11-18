"""新接的生视频厂商：火山方舟 Seedance、阿里云百炼万相、MiniMax 海螺。不联网，mock 所有请求。"""
import base64
import io
import json
import sys
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from console import config, jimmy_bridge, jobs, store  # noqa: E402
from console.gateway import routes  # noqa: E402
from console.gateway.adapters import video_vendors as vv  # noqa: E402

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096


class Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.enterContext(patch.object(config, "ENV_FILE", self.tmp / "video-vendors-test.env"))
        self.enterContext(patch.object(vv, "POLL_SECONDS", 0))
        self.files = {}
        for name, data in (("a.png", PNG), ("b.png", PNG), ("clip.mp4", MP4), ("voice.mp3", b"ID3" + b"\x00" * 64)):
            f = self.tmp / name
            f.write_bytes(data)
            self.files[name] = {"source": "file", "path": str(f), "sha256": store.sha256_file(f)}
        self.sent = []

    def task(self, **kw):
        return {"id": "t1", "prompt": "图1的人在图2的店里喝咖啡", "duration": 8, "ratio": "9:16",
                "images": [self.files["a.png"], self.files["b.png"]], "reference_videos": [], **kw}

    def fake(self, *replies):
        replies = list(replies)

        def urlopen(req, timeout=None, context=None):
            self.sent.append(req)
            out = replies.pop(0)
            if isinstance(out, Exception):
                raise out
            return Reply(out if isinstance(out, bytes) else json.dumps(out).encode())
        return patch("urllib.request.urlopen", side_effect=urlopen)


class PlanTests(Base):
    def test_ark_drops_reference_video_with_warning(self):
        info = vv.plan("ark", None, self.task(reference_videos=[self.files["clip.mp4"]]))
        self.assertEqual(info["model"], "doubao-seedance-2-0-260128")
        self.assertFalse(info["use_video"])
        self.assertIn("只用参考图", info["warnings"][0])
        self.assertIn("火山方舟账户计费", info["billing_note"])

    def test_bailian_keeps_video_under_ten_seconds_only(self):
        self.assertTrue(vv.plan("bailian", None, self.task(reference_videos=[self.files["clip.mp4"]]))["use_video"])
        info = vv.plan("bailian", None, self.task(duration=12, reference_videos=[self.files["clip.mp4"]]))
        self.assertFalse(info["use_video"])
        self.assertIn("最长只能出 10 秒", info["warnings"][0])

    def test_video_only_segment_needs_an_image_for_ark(self):
        with self.assertRaisesRegex(vv.VendorError, "至少需要一张参考图"):
            vv.plan("ark", None, self.task(images=[], reference_videos=[self.files["clip.mp4"]]))

    def test_hailuo_one_image_and_fixed_lengths(self):
        info = vv.plan("minimax", None, self.task(duration=8))
        self.assertEqual(info["output_seconds"], 10)
        self.assertTrue(any("第一张参考图" in w for w in info["warnings"]))
        self.assertTrue(any("会生成 10 秒" in w for w in info["warnings"]))

    def test_routes_accept_video_vendors(self):
        self.assertEqual(routes.parse("ark", "video"), {"channel": "ark", "model": "doubao-seedance-2-0-260128"})
        self.assertEqual(routes.parse("minimax:MiniMax-Hailuo-02", "video")["model"], "MiniMax-Hailuo-02")
        with self.assertRaises(ValueError):
            routes.parse("minimax", "storyboard_image")


class SegmentModeTests(Base):
    def test_plan_switches_to_image_when_video_model_cannot_use_clip(self):
        from console import segment_plan
        config.save({"ROUTE_VIDEO": "ark:doubao-seedance-2-0-260128"})
        plan = segment_plan.fit_video_model({"segments": [{"mode": "video", "duration": 8}, {"mode": "image", "duration": 5}]}, {})
        self.assertEqual([r["mode"] for r in plan["segments"]], ["image", "image"])
        self.assertIn("不能参考原片片段", plan["segments"][0]["mode_reason"])
        config.save({"ROUTE_VIDEO": "bailian:wan2.7-r2v"})
        plan = segment_plan.fit_video_model({"segments": [{"mode": "video", "duration": 8}, {"mode": "video", "duration": 12}]}, {})
        self.assertEqual([r["mode"] for r in plan["segments"]], ["video", "image"])
        config.save({"ROUTE_VIDEO": "third_party"})
        plan = segment_plan.fit_video_model({"segments": [{"mode": "video", "duration": 12}]}, {})
        self.assertEqual(plan["segments"][0]["mode"], "video")


class GenerateTests(Base):
    def run_generate(self, channel, task, *replies, **info):
        job = self.tmp / "job.json"
        job.write_text(json.dumps({"tasks": [task]}))
        run_dir = self.tmp / "runs" / "job1"
        with self.fake(*replies):
            child = vv.generate(channel, vv.default_model(channel), job, run_dir, "t1",
                                {"use_video": False, "use_voice": False, **info})
        return child, run_dir

    def test_ark_submit_poll_download(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        child, run_dir = self.run_generate("ark", self.task(), {"id": "cgt-1"}, {"status": "running"},
                                           {"status": "succeeded", "content": {"video_url": "https://ark-out.example/v.mp4"}}, MP4)
        submit, q1, q2, download = self.sent
        body = json.loads(submit.data)
        self.assertEqual(submit.full_url, "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks")
        self.assertEqual([c.get("role") for c in body["content"]], [None, "reference_image", "reference_image"])
        self.assertTrue(body["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual((body["duration"], body["ratio"], body["watermark"]), (8, "9:16", False))
        self.assertTrue(q1.full_url.endswith("/contents/generations/tasks/cgt-1"))
        self.assertNotIn("Authorization", download.headers, "下载结果不能带上 Key")
        self.assertEqual((child["phase"], child["jimmy_task_id"]), ("completed", "cgt-1"))
        self.assertEqual(Path(child["local_path"]).read_bytes(), MP4)
        self.assertTrue((run_dir / "job.json").is_file())

    def test_dropped_reference_video_is_explained_in_prompt(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        task = self.task(reference_videos=[self.files["clip.mp4"]])
        self.run_generate("ark", task, {"id": "c"}, {"status": "succeeded", "content": {"video_url": "https://x.example/v.mp4"}}, MP4)
        text = json.loads(self.sent[0].data)["content"][0]["text"]
        self.assertTrue(text.startswith("（说明：这次没有提供参考视频"))
        self.assertNotIn("video_url", json.dumps(json.loads(self.sent[0].data)["content"]))

    def test_bailian_uploads_to_temp_storage_then_submits(self):
        config.save({"QWEN_API_KEY": "bl-key"})
        policy = {"data": {"upload_host": "https://dashscope-file.example", "upload_dir": "dashscope-instant/abc",
                           "policy": "p", "signature": "s", "oss_access_key_id": "ak", "x_oss_object_acl": "private",
                           "x_oss_forbid_overwrite": "true"}}
        task = self.task(images=[self.files["a.png"]], reference_videos=[self.files["clip.mp4"]])
        child, _ = self.run_generate("bailian", task, policy, b"", policy, b"",
                                     {"output": {"task_id": "wan-1"}},
                                     {"output": {"task_status": "SUCCEEDED", "video_url": "https://bl-out.example/v.mp4"}}, MP4,
                                     use_video=True)
        upload = self.sent[1]
        self.assertIn(b'name="key"\r\n\r\ndashscope-instant/abc/', upload.data)
        submit = self.sent[4]
        body = json.loads(submit.data)
        self.assertEqual(submit.headers.get("X-dashscope-async"), "enable")
        self.assertEqual(submit.headers.get("X-dashscope-ossresourceresolve"), "enable")
        self.assertEqual([m["type"] for m in body["input"]["media"]], ["reference_image", "reference_video"])
        self.assertTrue(all(m["url"].startswith("oss://dashscope-instant/abc/") for m in body["input"]["media"]))
        self.assertEqual(child["phase"], "completed")

    def test_kling_via_bailian_uses_refer_media_and_image_tags(self):
        config.save({"QWEN_API_KEY": "bl-key"})
        policy = {"data": {"upload_host": "https://dashscope-file.example", "upload_dir": "dashscope-instant/k",
                           "policy": "p", "signature": "s", "oss_access_key_id": "ak", "x_oss_object_acl": "private",
                           "x_oss_forbid_overwrite": "true"}}
        child, _ = self.run_generate("kling", self.task(), policy, b"", policy, b"", {"output": {"task_id": "k-1"}},
                                     {"output": {"task_status": "SUCCEEDED", "video_url": "https://k.example/v.mp4"}}, MP4)
        body = json.loads(self.sent[4].data)
        self.assertEqual(body["model"], "kling/kling-v3-omni-video-generation")
        self.assertEqual([m["type"] for m in body["input"]["media"]], ["refer", "refer"])
        self.assertIn("<<<image_1>>>的人在<<<image_2>>>的店里", body["input"]["prompt"])
        self.assertEqual((body["parameters"]["aspect_ratio"], body["parameters"]["duration"]), ("9:16", 8))
        self.assertEqual(child["phase"], "completed")

    def test_minimax_resolves_file_id(self):
        config.save({"MINIMAX_API_KEY": "mm-key"})
        child, _ = self.run_generate("minimax", self.task(duration=5),
                                     {"task_id": "mm-1", "base_resp": {"status_code": 0}},
                                     {"status": "Success", "file_id": 42},
                                     {"file": {"download_url": "https://mm-out.example/v.mp4"}}, MP4)
        body = json.loads(self.sent[0].data)
        self.assertEqual((body["duration"], body["model"]), (6, "MiniMax-Hailuo-2.3"))
        self.assertTrue(self.sent[2].full_url.endswith("/files/retrieve?file_id=42"))
        self.assertEqual(child["phase"], "completed")

    def test_network_drop_on_submit_is_unknown_not_retryable(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        child, _ = self.run_generate("ark", self.task(), urllib.error.URLError("reset"))
        self.assertEqual(child["phase"], "submission_outcome_unknown")
        self.assertIsNotNone(child["request"], "不确定有没有提交成功时，不能允许自动重提")
        self.assertFalse(jimmy_bridge._upload_retryable(child))

    def test_rejected_by_moderation_is_failed_and_not_resubmitted(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        err = urllib.error.HTTPError("u", 400, "Bad", {}, io.BytesIO(b'{"error":{"message":"sensitive content"}}'))
        child, _ = self.run_generate("ark", self.task(), err)
        self.assertEqual(child["phase"], "failed")
        self.assertIn("没通过审核", child["error"]["message"])
        self.assertFalse(jimmy_bridge._upload_retryable(child))

    def test_model_not_open_says_where_to_activate(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        body = b'{"error":{"code":"ModelNotOpen","message":"Your account 1 has not activated the model doubao-seedance-2-0-260128."}}'
        err = urllib.error.HTTPError("u", 404, "Not Found", {}, io.BytesIO(body))
        child, _ = self.run_generate("ark", self.task(), err)
        self.assertIn("还没开通「doubao-seedance-2-0-260128」", child["error"]["message"])
        self.assertIn("开通管理", child["error"]["message"])
        self.assertEqual(child["error"]["kind"], "auth")

    def test_remote_moderation_failure_is_explained(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        child, _ = self.run_generate("ark", self.task(), {"id": "cgt-2"},
                                     {"status": "failed", "error": {"code": "InputImageSensitiveContentDetected", "message": "InputImageSensitiveContentDetected"}})
        self.assertIn("内容审核", child["error"]["message"])

    def test_rate_limit_before_task_creation_is_safely_retryable(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        err = urllib.error.HTTPError("u", 429, "Too many", {}, io.BytesIO(b"{}"))
        child, _ = self.run_generate("ark", self.task(), err)
        self.assertTrue(jimmy_bridge._upload_retryable(child))

    def test_query_network_error_keeps_task_id_for_later(self):
        config.save({"DOUBAO_API_KEY": "ark-key"})
        child, run_dir = self.run_generate("ark", self.task(), {"id": "cgt-9"}, urllib.error.URLError("timed out"))
        self.assertEqual((child["phase"], child["jimmy_task_id"]), ("running", "cgt-9"))
        from console import remote_query
        self.assertTrue(remote_query.transient(child["error"], child["status"]))
        with self.fake({"status": "succeeded", "content": {"video_url": "https://x.example/v.mp4"}}, MP4):
            done = vv.poll("ark", run_dir, "t1")
        self.assertEqual(done["phase"], "completed")
        self.assertEqual(len([r for r in self.sent if "contents/generations/tasks" in r.full_url and r.data]), 1, "只提交过一次")


class BridgeFlowTests(Base):
    """项目里确认之后：交给厂商 → 查询 → 下载 → 这一段显示已完成。"""

    def test_confirmed_run_completes_through_vendor(self):
        projects = self.tmp / "proj-test"; projects.mkdir()
        self.enterContext(patch.object(config, "PROJECTS_DIR", projects))
        config.save({"DOUBAO_API_KEY": "ark-key"})
        pid = store.create("生视频厂商")["id"]
        d = store.project_dir(pid)
        review = d / "packages" / "t1-r1" / "review"; review.mkdir(parents=True)
        frozen = review / "jimmy-job.json"
        frozen.write_text(json.dumps({"tasks": [self.task()]}))
        run = {"rev": "r1", "job_id": "job1", "state": "submitting", "channel": "ark", "model": "doubao-seedance-2-0-260128",
               "mode": "image", "package": "packages/t1-r1", "job_sha256": store.sha256_file(frozen),
               "run_dir": "jimmy-runs/job1", "vendor": {"use_video": False, "use_voice": False}, "submitted_at": time.time()}
        store.update(pid, lambda x: x.setdefault("runs", {}).__setitem__("t1", [run]))
        with self.fake({"id": "cgt-7"}, {"status": "succeeded", "content": {"video_url": "https://o.example/v.mp4"}}, MP4), \
                patch.object(jimmy_bridge, "_call", side_effect=AssertionError("厂商渠道不能调三方脚本")), \
                patch.object(jimmy_bridge, "_schedule_motion_check"):
            jimmy_bridge._start_generate(pid, "t1", "r1")
            for _ in range(200):
                if jobs.snapshot(pid).get("gen:t1:r1", {}).get("state") != "running":
                    break
                time.sleep(0.02)
        done = store.load(pid)["runs"]["t1"][0]
        self.assertEqual(done["state"], "completed", done.get("error"))
        self.assertEqual(done["remote_task_id"], "cgt-7")
        self.assertEqual((d / done["result"]).read_bytes(), MP4)


if __name__ == "__main__":
    unittest.main()
