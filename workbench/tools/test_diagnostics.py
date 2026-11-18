"""导出问题报告：只有文字，任何地方都不能带出 Key。"""
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from console import config, diagnostics, local_llm, paths, store  # noqa: E402

KEY = "sk-live-abcdef1234567890SECRET"
ARK = "ark-9f8e7d6c5b4a-volc-key-xyz"


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.runtime = tmp / "runtime"; self.runtime.mkdir()
        self.projects = tmp / "proj-test"; self.projects.mkdir()
        self.enterContext(patch.object(paths, "RUNTIME_DIR", self.runtime))
        self.enterContext(patch.object(config, "ENV_FILE", tmp / "diag-test.env"))
        self.enterContext(patch.object(config, "PROJECTS_DIR", self.projects))
        self.enterContext(patch.object(local_llm, "hardware", return_value={"ram_gb": 16, "gpu": None}))
        config.save({"OPENAI_API_KEY": KEY, "DOUBAO_API_KEY": ARK, "ROUTE_VIDEO": "ark:doubao-seedance-2-0-260128"})

    def test_zip_has_logs_settings_and_project_but_no_keys(self):
        (self.runtime / "server.log").write_text(
            f"start\nPOST /v1 Authorization: Bearer {ARK}\nopenai key={KEY}\nother sk-unknownkey0123456789abc\n", encoding="utf-8")
        pid = store.create("烤鱼店")["id"]
        store.log(pid, f"调用失败 key={KEY}")
        out = diagnostics.build(pid)
        self.assertTrue(out.name.endswith(".zip"))
        with zipfile.ZipFile(out) as zf:
            names = set(zf.namelist())
            blob = "\n".join(zf.read(n).decode("utf-8") for n in names)
            settings = json.loads(zf.read("settings.json"))
            project = json.loads(zf.read("project.json"))
        self.assertTrue({"说明.txt", "summary.json", "settings.json", "logs/server.log", "project.json"} <= names)
        for secret in (KEY, ARK, KEY[-4:] + "\n", "sk-unknownkey0123456789abc"):
            self.assertNotIn(secret.strip() if len(secret) > 8 else secret, blob)
        self.assertEqual(settings["OPENAI_API_KEY"], "已填写")
        self.assertEqual(settings["ROUTE_VIDEO"], "ark:doubao-seedance-2-0-260128")
        self.assertEqual(project["name"], "烤鱼店")
        self.assertIn("***", "".join(e["msg"] for e in project["log"]))

    def test_works_without_logs_or_project(self):
        out = diagnostics.build(None)
        with zipfile.ZipFile(out) as zf:
            self.assertNotIn("project.json", zf.namelist())
            self.assertEqual(json.loads(zf.read("summary.json"))["hardware"]["ram_gb"], 16)


if __name__ == "__main__":
    unittest.main()
