"""软件更新：检查时带回新版本的更新说明；当前版本的说明；桌面版更新后用约定退出码重启。"""
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import updater  # noqa: E402

LOG = [{"version": "20261118-0900", "date": "2026-11-18", "items": ["新功能 B"]},
       {"version": "20261117-2300", "date": "2026-11-17", "items": ["新功能 A"]},
       {"version": "20261117-2000", "date": "2026-11-17", "items": ["旧的"]},
       {"version": "bad", "items": ["忽略"]}, {"version": "20261101-0000", "items": []}]


class UpdateNotesTests(unittest.TestCase):
    def test_parse_and_filter(self):
        entries = updater.parse_changelog(json.dumps(LOG))
        self.assertEqual([e["version"] for e in entries], ["20261118-0900", "20261117-2300", "20261117-2000"])
        self.assertEqual([e["version"] for e in updater.changelog_since(entries, "20261117-2000")], ["20261118-0900", "20261117-2300"])
        self.assertEqual(updater.changelog_since(entries, "20261117-2300", include=True)[-1]["items"], ["新功能 A"])
        self.assertEqual(updater.parse_changelog(b"not json"), [])

    def test_changelog_lives_where_old_updaters_accept_it(self):
        self.assertTrue(updater.allowed(updater.CHANGELOG))
        self.assertTrue((ROOT / updater.CHANGELOG).exists())
        entries = updater.read_changelog(ROOT / updater.CHANGELOG)
        self.assertTrue(entries, "仓库里的更新说明要能被解析")
        self.assertTrue(all(re.fullmatch(r"\d{8}-\d{4}", e["version"]) for e in entries))

    def test_check_returns_notes_newer_than_current(self):
        root = Path(tempfile.mkdtemp())
        (root / "VERSION").write_text("20261117-2000\n")
        (root / "web").mkdir()
        (root / "web/changelog.json").write_text(json.dumps(LOG, ensure_ascii=False))
        (root / updater.MANIFEST).write_text(json.dumps({"format": 1, "runtime": 1, "version": "20261117-2000",
                                                         "files": {"server.py": "0" * 64}}))
        service = updater.Updater(root)
        new_manifest = {"format": 1, "runtime": 1, "version": "20261118-0900", "files": {"server.py": "1" * 64}}
        replies = [json.dumps({"sha": "a" * 40}).encode(), json.dumps(new_manifest).encode(), json.dumps(LOG).encode()]
        with patch.object(updater, "download", side_effect=replies) as fetch:
            result = service.check()
        self.assertIn("/web/changelog.json", fetch.call_args_list[2].args[0])
        self.assertEqual([n["version"] for n in result["available"]["notes"]], ["20261118-0900", "20261117-2300"])
        self.assertEqual(result["current_notes"][0]["items"], ["旧的"])

    def test_missing_remote_notes_do_not_block_update(self):
        root = Path(tempfile.mkdtemp())
        (root / "VERSION").write_text("20261117-2000\n")
        (root / updater.MANIFEST).write_text(json.dumps({"format": 1, "runtime": 1, "version": "20261117-2000",
                                                         "files": {"server.py": "0" * 64}}))
        service = updater.Updater(root)
        new_manifest = {"format": 1, "runtime": 1, "version": "20261118-0900", "files": {"server.py": "1" * 64}}
        replies = [json.dumps({"sha": "a" * 40}).encode(), json.dumps(new_manifest).encode()]   # 第三次下载（说明）会失败
        with patch.object(updater, "download", side_effect=replies):
            result = service.check()
        self.assertEqual(result["available"]["notes"], [])
        self.assertEqual(result["current_notes"], [])

    def test_desktop_restart_uses_agreed_exit_code(self):
        server = (ROOT / "server.py").read_text(encoding="utf-8")
        main_js = (ROOT.parent / "build/main.js").read_text(encoding="utf-8")
        code = re.search(r"RESTART_EXIT_CODE = (\d+)", server).group(1)
        self.assertIn(f"const RESTART_EXIT_CODE = {code};", main_js)
        self.assertIn("os._exit(RESTART_EXIT_CODE)", server)
        self.assertIn("env.VIRALREPLICA_SHELL = 'desktop'", main_js)


if __name__ == "__main__":
    unittest.main()
