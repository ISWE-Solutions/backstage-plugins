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


class FakeApi:
    """Records Proxmox API calls; containers is {vmid: tags}"""

    def __init__(self, containers=None):
        self.calls = []
        self.containers = dict(containers or {})

    def call(self, method, path, data=None):
        self.calls.append((method, path, data))
        vmid = int(path.split("/lxc/")[1].split("/")[0]) if "/lxc/" in path else None
        if method == "GET" and path.endswith("/config"):
            if vmid not in self.containers:
                raise rb.ProxmoxError(500, "does not exist")
            return {"tags": self.containers[vmid]}
        if method == "GET" and path.endswith("/status/current"):
            return {"status": "running"}
        if method == "DELETE":
            self.containers.pop(vmid, None)
        if method == "POST" and path.endswith("/clone"):
            self.containers[data["newid"]] = ""
        if method == "PUT" and path.endswith("/config"):
            self.containers[vmid] = data.get("tags", "")
        return "UPID:pve02:0001:task:"

    def wait(self, node, upid, timeout=600):
        pass


class FakeSsh:
    def __init__(self):
        self.commands = []

    def run(self, args, **kw):
        self.commands.append(args[-1])
        if kw.get("stdin") is not None:
            kw["stdin"].read()
        return type("R", (), {"returncode": 0, "stdout": ""})()


def proxmox_builder(tmp, workers=2):
    settings = rb.Settings(host="b1", workers=workers, workdir=Path(tmp), github_token="", memory="4g", cpus="3",
                           executors=("docker", "proxmox"), proxmox={
                               "PROXMOX_URL": "https://pve02:8006", "PROXMOX_TOKEN_ID": "runbot@pve!builder",
                               "PROXMOX_TOKEN_SECRET": "s", "PROXMOX_NODE": "pve02",
                               "PROXMOX_TEMPLATES": '{"19.0": 9019}', "PROXMOX_VMIDS": "860",
                               "PROXMOX_IPS": "192.168.12.200, 192.168.12.201", "PROXMOX_GATEWAY": "192.168.12.100"})
    return rb.Builder(rb.Backend("http://x", "t"), settings)


class Executors(unittest.TestCase):
    def test_memory_and_command(self):
        self.assertEqual(rb.parse_memory_mb("4g"), 4096)
        self.assertEqual(rb.parse_memory_mb("1536m"), 1536)
        cmd = rb.odoo_command("odoo", {"testTags": "/meal", "demo": False}, "runbot_1_all", ["meal", "sdp"])
        self.assertEqual(cmd[:5], ["/data/src/odoo/odoo-bin", "-d", "runbot_1_all", "-i", "meal,sdp"])
        self.assertIn("--without-demo=all", cmd)
        self.assertEqual(cmd[cmd.index("--test-tags") + 1], "/meal")

    def test_unknown_or_unsupported_executor(self):
        a = assignment()
        a["params"]["executor"] = "kubernetes"
        with self.assertRaises(ValueError):
            rb.validate(a)
        with tempfile.TemporaryDirectory() as d:
            b = proxmox_builder(d)
            b.s.executors = ("docker",)
            with self.assertRaises(RuntimeError):
                b.executor_for({"executor": "proxmox"}, 0)
            self.assertIsInstance(b.executor_for({"executor": "docker"}, 0), rb.DockerExecutor)

    def test_slot_vmid_and_ip(self):
        with tempfile.TemporaryDirectory() as d:
            b = proxmox_builder(d)
            ex = rb.ProxmoxExecutor(b, 1, api=FakeApi(), ssh=FakeSsh())
            self.assertEqual((ex.vmid, ex.ip), (861, "192.168.12.201"))
            b.s.workers = 3
            with self.assertRaises(RuntimeError):
                rb.ProxmoxExecutor(b, 2, api=FakeApi(), ssh=FakeSsh())

    def test_refuses_to_touch_a_container_that_is_not_a_build(self):
        with tempfile.TemporaryDirectory() as d:
            api = FakeApi({860: "shared;prod"})
            ex = rb.ProxmoxExecutor(proxmox_builder(d), 0, api=api, ssh=FakeSsh())
            with self.assertRaises(RuntimeError):
                ex.destroy_slot()
            self.assertFalse(any(m == "DELETE" for m, _, _ in api.calls))

    def test_prepare_clones_configures_starts_and_copies(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "build"
            (root / "src" / "meal").mkdir(parents=True)
            (root / "src" / "meal" / "requirements.txt").write_text("phonenumbers\n")
            api = FakeApi({860: "runbot-build"})  # a leftover from a crash
            ssh = FakeSsh()
            ex = rb.ProxmoxExecutor(proxmox_builder(d), 0, api=api, ssh=ssh)
            params = assignment()["params"]
            params["commits"][1]["repoName"] = "meal"
            ex.prepare(12, params, root, rb.LogSender(rb.Backend("http://x", "t"), None))
            methods = [(m, p.split("/lxc/")[1] if "/lxc/" in p else p) for m, p, _ in api.calls]
            self.assertEqual(methods[:4], [("GET", "860/config"), ("GET", "860/status/current"),
                                           ("POST", "860/status/stop"), ("DELETE", "860")])
            clone = next(c for c in api.calls if c[1].endswith("/clone"))
            self.assertEqual(clone[1], "/nodes/pve02/lxc/9019/clone")
            self.assertEqual((clone[2]["newid"], clone[2]["full"], clone[2]["pool"]), (860, 0, "runbot"))
            config = next(c for c in api.calls if c[0] == "PUT")[2]
            self.assertIn("ip=192.168.12.200/24,gw=192.168.12.100", config["net0"])
            self.assertEqual((config["memory"], config["cores"], config["tags"]), (4096, 3, "runbot-build"))
            self.assertTrue(any(m == "POST" and p.endswith("/status/start") for m, p, _ in api.calls))
            self.assertEqual(ssh.commands[0], "true")
            self.assertTrue(any("pip install --quiet -r /data/src/meal/requirements.txt" in c for c in ssh.commands))

    def test_no_template_for_the_version(self):
        with tempfile.TemporaryDirectory() as d:
            ex = rb.ProxmoxExecutor(proxmox_builder(d), 0, api=FakeApi(), ssh=FakeSsh())
            params = assignment()["params"]
            params["version"] = "18.0"
            with self.assertRaises(RuntimeError):
                ex.prepare(1, params, Path(d), rb.LogSender(rb.Backend("http://x", "t"), None))
