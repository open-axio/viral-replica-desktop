"""识别台词默认用 CPU；显式选了显卡但显卡库缺失时自动退回 CPU（Windows 真机：cublas64_12.dll 缺失）。"""
import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy  # noqa: E402,F401  先导入，patch.dict 还原 sys.modules 时不会把它卸掉
from console import asr, config  # noqa: E402

CREATED = []


class FakeModel:
    def __init__(self, size, device="auto", compute_type="int8", local_files_only=False):
        self.device = device
        CREATED.append(device)

    def transcribe(self, audio, **kw):
        def gen():
            if self.device != "cpu":
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            yield types.SimpleNamespace(start=0.0, end=1.0, text=" 你好 ", words=[types.SimpleNamespace(start=0.0, end=0.5, word="你好")])
        return gen(), types.SimpleNamespace(language="en")


def wav_file() -> Path:
    path = Path(tempfile.mkdtemp()) / "a.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 1600)
    return path


class AsrDeviceTests(unittest.TestCase):
    def setUp(self):
        CREATED.clear()
        asr._model, asr._model_key = None, None
        fake = types.ModuleType("faster_whisper"); fake.WhisperModel = FakeModel
        self.enterContext(patch.dict(sys.modules, {"faster_whisper": fake}))

    def test_default_is_cpu(self):
        with patch.dict("os.environ", {"ASR_DEVICE": ""}), patch.object(config, "get", lambda k: ""):
            out = asr.transcribe(wav_file(), "small")
        self.assertEqual(CREATED, ["cpu"])
        self.assertEqual(out["segments"][0]["text"], "你好")

    def test_gpu_failure_falls_back_to_cpu(self):
        with patch.dict("os.environ", {"ASR_DEVICE": "cuda"}):
            out = asr.transcribe(wav_file(), "small")
        self.assertEqual(CREATED, ["cuda", "cpu"])
        self.assertEqual(out["segments"][0]["words"][0]["word"], "你好")
        self.assertNotIn("cuda", out["engine"])

    def test_other_errors_are_not_hidden(self):
        class Broken(FakeModel):
            def transcribe(self, audio, **kw):
                raise ValueError("音频坏了")
        sys.modules["faster_whisper"].WhisperModel = Broken
        with patch.dict("os.environ", {"ASR_DEVICE": "cuda"}), self.assertRaisesRegex(ValueError, "音频坏了"):
            asr.transcribe(wav_file(), "small")
        self.assertIsNone(asr._model, "失败后不留半坏的模型")


if __name__ == "__main__":
    unittest.main()
