"""04 认拍摄方式：镜号对齐、开关策略、prompt 注入。不解码视频，不起子进程。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from console import forensics, prompts  # noqa: E402

SHOTS = [{"index": 1, "start": 0.0, "end": 2.5}, {"index": 2, "start": 2.5, "end": 6.0},
         {"index": 3, "start": 6.0, "end": 9.0}]


def verdict(s, cls="ai", label="ai_video", zh="AI 生成视频"):
    return {**s, "class": cls, "class_zh": forensics.CLASSES[cls], "label": label, "label_zh": zh,
            "confidence": 0.71, "evidence": ["无传感器噪点", "边缘过渡异常平滑"]}


class AlignmentTests(unittest.TestCase):
    def test_same_count_and_intervals_pass(self):
        forensics.check_alignment(SHOTS, [verdict(s) for s in SHOTS])

    def test_count_mismatch_fails(self):
        with self.assertRaisesRegex(forensics.AlignmentError, "2 条，03 有 3 个镜头"):
            forensics.check_alignment(SHOTS, [verdict(s) for s in SHOTS[:2]])

    def test_shifted_interval_fails(self):
        bad = [verdict(s) for s in SHOTS]
        bad[1] = {**bad[1], "start": 2.4}
        with self.assertRaisesRegex(forensics.AlignmentError, "第 2 条"):
            forensics.check_alignment(SHOTS, bad)

    def test_every_rea_label_maps_to_a_class(self):
        from console.vendor.rea_video.classify import LABELS
        self.assertEqual(set(forensics.CLASS_OF), set(LABELS))
        self.assertTrue(set(forensics.CLASS_OF.values()) <= set(forensics.CLASSES))


class SwitchTests(unittest.TestCase):
    def test_auto_follows_duration_limit(self):
        self.assertTrue(forensics.decide_run({}, 119)[0])
        run, why = forensics.decide_run({}, 121)
        self.assertFalse(run)
        self.assertIn("on", why)

    def test_custom_limit_and_explicit_modes(self):
        self.assertFalse(forensics.decide_run({"DEEP_FORENSICS_MAX_SECONDS": "30"}, 31)[0])
        self.assertTrue(forensics.decide_run({"DEEP_FORENSICS": "on"}, 3600)[0])
        self.assertEqual(forensics.decide_run({"DEEP_FORENSICS": "off"}, 5), (False, "设置里关闭了「深度取证」"))
        self.assertTrue(forensics.decide_run({"DEEP_FORENSICS_MAX_SECONDS": "abc"}, 60)[0])


class PromptTests(unittest.TestCase):
    result = {"shots": [verdict(SHOTS[0], "live", "live_action", "实拍"), verdict(SHOTS[1]),
                        verdict(SHOTS[2], "graphic", "code_render", "代码/模板渲染")]}

    def test_overview_gets_every_shot(self):
        text = prompts.overview_user_text({"duration": 9}, [], None, [], self.result)
        self.assertEqual(text.count("本镜判定"), 3)
        self.assertIn("镜 2（2.50–6.00s）本镜判定：AI 生成，细分：AI 生成视频", text)
        self.assertIn("依据：无传感器噪点；边缘过渡异常平滑", text)
        self.assertNotIn("细分：实拍", text)

    def test_close_reading_only_gets_overlapping_shots(self):
        passage = {"id": "P2", "start": 3.0, "end": 6.5, "phase": "proof", "summary": "x"}
        text = prompts.close_user_text(passage, {}, None, 0.5, self.result)
        self.assertNotIn("镜 1（", text)
        self.assertIn("镜 2（", text)
        self.assertIn("镜 3（", text)

    def test_no_result_leaves_prompts_unchanged(self):
        self.assertEqual(prompts.overview_user_text({"duration": 9}, [], None, [], None),
                         prompts.overview_user_text({"duration": 9}, [], None, []))
        self.assertNotIn("拍摄方式", prompts.overview_user_text({"duration": 9}, [], None, []))

    def test_report_lists_every_shot(self):
        md = forensics.report_md({**self.result, "engine": forensics.ENGINE, "seconds": 1.0,
                                  "counts": {"live": 1, "ai": 1, "graphic": 1}})
        self.assertIn("实拍 1 镜，AI 生成 1 镜，图文动画 1 镜", md)
        self.assertEqual(sum(line.startswith("| ") and line[2].isdigit() for line in md.splitlines()), 3)


if __name__ == "__main__":
    unittest.main()
