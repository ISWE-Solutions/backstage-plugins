"""Tests for the builder's rules: python3 -m unittest discover -s tests (from ansible/)"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "roles" / "runbot_builder" / "files"))
import runbot_builder as rb  # noqa: E402


def assignment(**patch):
    a = {
        "buildId": 12,
        "dbName": "runbot_12_all",
        "params": {
            "version": "19.0",
            "commits": [
                {"repoId": 1, "repoName": "odoo", "slug": "odoo/odoo", "sha": "a" * 40, "isServer": True,
                 "addonsSubdir": "", "tested": False},
                {"repoId": 2, "repoName": "iswe_meal_addons", "slug": "ISWE-Solutions/iswe_meal_addons",
                 "sha": "b" * 40, "isServer": False, "addonsSubdir": "", "tested": True},
            ],
            "steps": [{"type": "install_test", "modules": ["*"], "excludeModules": [], "testTags": "",
                       "demo": True, "timeout": 3600}],
        },
    }
    a.update(patch)
    return a


class Rules(unittest.TestCase):
    def test_parse_and_classify(self):
        rec = rb.parse_line("2026-10-27 10:15:02,123 4567 ERROR runbot_12_all odoo.addons.meal.tests: FAIL: test_x")
        self.assertEqual(rec, {"level": "ERROR", "logger": "odoo.addons.meal.tests", "message": "FAIL: test_x"})
        self.assertIsNone(rb.parse_line("Traceback (most recent call last):"))
        self.assertEqual(rb.classify(rec), "error")
        self.assertIsNone(rb.classify({"level": "WARNING", "logger": "x", "message": "Test test_a took 3s to run"}))

    def test_results(self):
        self.assertEqual(rb.build_result(0, False, False, 0, 0), "ok")
        self.assertEqual(rb.build_result(0, False, False, 0, 1), "warn")
        self.assertEqual(rb.build_result(1, False, False, 0, 0), "ko")
        self.assertEqual(rb.build_result(0, True, False, 0, 0), "ko")
        self.assertEqual(rb.build_result(0, False, True, 4, 0), "killed")
        self.assertEqual(rb.worst("warn", "ok"), "warn")
        self.assertEqual(rb.worst("ok", "ko"), "ko")

    def test_modules(self):
        self.assertEqual(rb.select_modules(["meal", "meal_ai", "theme"], ["meal*"], ["*_ai"]), ["meal"])
        with tempfile.TemporaryDirectory() as d:
            for name, manifest in (("meal", "{'name': 'MEAL'}"), ("old", "{'installable': False}"),
                                   ("broken", "{not python")):
                (Path(d) / name).mkdir()
                (Path(d) / name / "__manifest__.py").write_text(manifest)
            (Path(d) / "docs").mkdir()
            self.assertEqual(rb.find_modules(Path(d)), ["meal"])

    def test_validation_refuses_anything_unexpected(self):
        rb.validate(assignment())
        bad = [
            {"dbName": "postgres"},
            {"dbName": "runbot_12_all; drop"},
        ]
        for patch in bad:
            with self.assertRaises(ValueError):
                rb.validate(assignment(**patch))
        for field, value in (("slug", "../etc"), ("sha", "HEAD"), ("addonsSubdir", "../../root"),
                             ("addonsSubdir", "/etc"), ("repoName", "a/b")):
            a = assignment()
            a["params"]["commits"][1][field] = value
            with self.assertRaises(ValueError, msg=f"{field}={value}"):
                rb.validate(a)
        a = assignment()
        a["params"]["steps"][0]["testTags"] = "x; rm -rf /"
        with self.assertRaises(ValueError):
            rb.validate(a)
        a = assignment()
        a["params"]["commits"][0]["isServer"] = False
        with self.assertRaises(ValueError):
            rb.validate(a)

    def test_git_credentials_stay_out_of_argv(self):
        env = rb.git_env("secret-token")
        self.assertEqual(env["GIT_CONFIG_KEY_0"], "http.https://github.com/.extraheader")
        self.assertNotIn("secret-token", env["GIT_CONFIG_VALUE_0"])  # base64, in the environment only

    def test_free_ports_differ(self):
        self.assertNotEqual(rb.free_port(), 0)


if __name__ == "__main__":
    unittest.main()
