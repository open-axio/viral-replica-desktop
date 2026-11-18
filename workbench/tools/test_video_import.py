"""找爆款 → 同款复刻：导入接口只收导入目录里的文件，来源信息清洗后存进项目。"""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from console import config, store, video_import  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FFMPEG = ROOT / "runtime" / "ffmpeg"
# 优先用工作台自带的 FFmpeg（离线测试只放行它）；没有就用系统的，都没有就跳过媒体用例
if (RUNTIME_FFMPEG / "ffmpeg").exists() or (RUNTIME_FFMPEG / "ffmpeg.exe").exists():
    import os
    os.environ["PATH"] = str(RUNTIME_FFMPEG) + os.pathsep + os.environ.get("PATH", "")
_OFFLINE = Path(getattr(sys.modules.get("__main__"), "__file__", "") or "").name == "run_tests_offline.py"
_FFMPEG = shutil.which("ffmpeg")
HAS_FFMPEG = bool(_FFMPEG) and (not _OFFLINE or Path(_FFMPEG).resolve().parent == RUNTIME_FFMPEG.resolve())


def make_clip(path: Path, audio: bool = True, video: bool = True) -> Path:
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if video:
        cmd += ["-f", "lavfi", "-i", "testsrc=size=320x568:rate=25:duration=2"]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"]
    if video:
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    if audio:
        cmd += ["-c:a", "aac"]
    subprocess.run(cmd + [str(path)], check=True)
    return path


class VideoImportTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        self.projects = tmp / "proj-test"; self.projects.mkdir()  # 不叫 projects：离线测试的审计按目录名拦删除
        self.dir = tmp / "browse-import"; self.dir.mkdir()
        self.enterContext(patch.object(config, "PROJECTS_DIR", self.projects))
        self.enterContext(patch.object(store, "PROJECTS_DIR", self.projects, create=True))
        self.enterContext(patch.object(video_import, "IMPORT_DIR", self.dir))

    def test_clean_origin_keeps_only_known_fields_and_limits(self):
        o = video_import.clean_origin({
            "platform": "douyin", "url": "https://www.douyin.com/video/1", "author": "老王烤鱼",
            "desc": "x" * 5000, "stats": {"likes": "12.3万", "hack": "1"},
            "comments": [{"user": "a", "text": "好吃", "likes": "9"}] * 30 + [{"text": ""}],
            "evil": "<script>",
        })
        self.assertEqual(o["platform_name"], "抖音")
        self.assertEqual(len(o["desc"]), 2000)
        self.assertEqual(o["stats"], {"likes": "12.3万"})
        self.assertEqual(len(o["comments"]), 20)
        self.assertNotIn("evil", o)
        self.assertEqual(video_import.clean_origin({"platform": "x", "url": "javascript:alert(1)"})["url"], "")
        self.assertEqual(video_import.clean_origin({"platform": "x"})["platform"], "other")

    def test_project_name_reads_like_a_title(self):
        o = video_import.clean_origin({"platform": "xiaohongshu", "author": "美甲小林",
                                       "title": "秋冬显白猫眼 #美甲 #显白"})
        self.assertEqual(video_import.project_name(o), "小红书 · 美甲小林 · 秋冬显白猫眼")

    def test_rejects_files_outside_import_dir(self):
        outside = Path(tempfile.mkdtemp()) / "a.mp4"
        outside.write_bytes(b"x")
        self.addCleanup(shutil.rmtree, outside.parent, True)
        with self.assertRaisesRegex(ValueError, "导入目录"):
            video_import.import_video({"video": str(outside)})
        with self.assertRaisesRegex(ValueError, "导入目录"):
            video_import.import_video({"video": str(self.dir / ".." / "x.mp4")})
        with self.assertRaisesRegex(ValueError, "没有拿到"):
            video_import.import_video({})
        self.assertEqual(list(self.projects.iterdir()), [])

    @unittest.skipUnless(HAS_FFMPEG, "需要 ffmpeg")
    def test_import_single_file_creates_project_with_origin(self):
        clip = make_clip(self.dir / "v.mp4")
        out = video_import.import_video({"video": str(clip), "origin": {
            "platform": "douyin", "author": "老王烤鱼", "desc": "长沙烤鱼天花板", "url": "https://www.douyin.com/video/7"}})
        data = store.load(out["id"])
        self.assertEqual(data["origin"]["author"], "老王烤鱼")
        self.assertTrue(data["source"]["probe"]["has_video"])
        self.assertEqual(data["source"]["probe"]["audio_stream_count"], 1)
        self.assertFalse(clip.exists(), "导入后临时文件要清掉")
        listed = {p["id"]: p for p in store.list_projects()}
        self.assertEqual(listed[out["id"]]["origin"], "抖音")
        # 还没拆解时，首页卡片用视频里取的一帧当封面
        self.assertEqual(listed[out["id"]]["thumb"], "source/poster.jpg")
        self.assertTrue((store.project_dir(out["id"]) / "source" / "poster.jpg").stat().st_size > 500)

    @unittest.skipUnless(HAS_FFMPEG, "需要 ffmpeg")
    def test_import_merges_separate_audio(self):
        v = make_clip(self.dir / "v.mp4", audio=False)
        a = make_clip(self.dir / "a.m4a", video=False)
        out = video_import.import_video({"video": str(v), "audio": str(a), "origin": {"platform": "bilibili"}})
        probe = store.load(out["id"])["source"]["probe"]
        self.assertTrue(probe["has_video"])
        self.assertEqual(probe["audio_stream_count"], 1)
        self.assertEqual(sorted(self.dir.iterdir()), [])


class OriginPromptTests(unittest.TestCase):
    def test_origin_context_only_when_present(self):
        from console import prompts
        probe = {"duration": 10, "width": 720, "height": 1280, "fps": 30, "audio_stream_count": 1}
        base = prompts.overview_user_text(probe, [], None, [])
        self.assertEqual(base, prompts.overview_user_text(probe, [], None, [], None, None))
        self.assertNotIn("原视频在平台上的信息", base)
        o = video_import.clean_origin({"platform": "douyin", "author": "老王烤鱼", "desc": "长沙烤鱼天花板 #探店",
                                       "stats": {"likes": "3.2万"}, "comments": [{"text": "在哪个位置？"}]})
        text = prompts.overview_user_text(probe, [], None, [], None, o)
        for want in ("原视频在平台上的信息", "老王烤鱼", "长沙烤鱼天花板", "点赞 3.2万", "在哪个位置？"):
            self.assertIn(want, text)
        self.assertEqual(prompts.origin_text(video_import.clean_origin({"platform": "bilibili"})), [])


if __name__ == "__main__":
    unittest.main()
