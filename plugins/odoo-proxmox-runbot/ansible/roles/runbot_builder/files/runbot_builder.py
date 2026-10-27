#!/usr/bin/env python3
"""ISWE Runbot builder: claims builds from the Backstage runbot backend and runs them.

Standard library only. Needs git, docker and PostgreSQL client tools on the host,
and a PostgreSQL server the build containers can reach (host network). Settings come
from the environment (see builder.env.example):

  RUNBOT_URL       https://backstage.example.com/api/odoo-runbot
  RUNBOT_TOKEN     static token (backend.auth.externalAccess, subject odoo-runbot-builder)
  GITHUB_TOKEN     read access to the repositories (private ones need it)
  RUNBOT_HOST      this builder's name (default: the hostname)
  RUNBOT_WORKERS   builds run at the same time (default 2)
  RUNBOT_WORKDIR   cache, builds and images (default /srv/runbot)
  PGHOST/PGPORT/PGUSER/PGPASSWORD  the PostgreSQL role builds use (CREATEDB, no superuser)
  RUNBOT_MEMORY    memory limit per build container (default 3g)
  RUNBOT_CPUS      CPUs per build container (default 1.5)
"""
from __future__ import annotations

import ast
import base64
import fnmatch
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

VERSION = "0.1.0"
_log = logging.getLogger("runbot-builder")

SLUG = re.compile(r"^[A-Za-z0-9-]{1,39}/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$")
SHA = re.compile(r"^[0-9a-f]{40}$")
DBNAME = re.compile(r"^runbot_\d+_[a-z0-9_]{1,40}$")
NAME = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
SUBDIR = re.compile(r"^(?!.*\.\.)[A-Za-z0-9_./-]{0,200}$")
GLOB = re.compile(r"^[A-Za-z0-9_*?]+$")
TAGS = re.compile(r"^[A-Za-z0-9_,:/.*+-]*$")
ODOO_LINE = re.compile(
    r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} \d+ (DEBUG|INFO|WARNING|ERROR|CRITICAL|TEST|RUNBOT) \S+ ([\w.]+): (.*)$"
)
IGNORED_WARNINGS = [re.compile(r"^Tests? .* took .* to (run|complete)"), re.compile(r"^Comparing .*:\s*$")]


# --------------------------------------------------------------------------- rules
# The same rules as @iswesolutions/plugin-odoo-runbot-common (logs.ts, modules.ts)

def parse_line(line: str):
    m = ODOO_LINE.match(line)
    if not m:
        return None
    level = "INFO" if m.group(1) == "TEST" else m.group(1)
    return {"level": level, "logger": m.group(2), "message": m.group(3)}


def classify(rec: dict) -> str | None:
    if rec["level"] in ("ERROR", "CRITICAL"):
        return "error"
    if rec["level"] == "WARNING" and not any(r.search(rec["message"]) for r in IGNORED_WARNINGS):
        return "warning"
    return None


def build_result(exit_code, timed_out: bool, killed: bool, errors: int, warnings: int) -> str:
    if killed:
        return "killed"
    if timed_out or exit_code != 0 or errors > 0:
        return "ko"
    return "warn" if warnings > 0 else "ok"


def select_modules(available, include, exclude):
    inc = include or ["*"]
    return sorted(
        m for m in set(available)
        if any(fnmatch.fnmatchcase(m, g) for g in inc) and not any(fnmatch.fnmatchcase(m, g) for g in exclude)
    )


def find_modules(root: Path) -> list[str]:
    """Installable modules directly under root"""
    found = []
    if not root.is_dir():
        return found
    for manifest in sorted(root.glob("*/__manifest__.py")):
        try:
            data = ast.literal_eval(manifest.read_text(encoding="utf-8"))
        except (ValueError, SyntaxError, UnicodeDecodeError):
            continue
        if isinstance(data, dict) and data.get("installable", True):
            found.append(manifest.parent.name)
    return found


def validate(assignment: dict) -> dict:
    """Everything the backend sent is checked again before it reaches a path or a command"""
    if not isinstance(assignment.get("buildId"), int) or not DBNAME.match(assignment.get("dbName", "")):
        raise ValueError("bad build id or database name")
    params = assignment["params"]
    if not re.match(r"^[\w.-]{1,20}$", params.get("version", "")):
        raise ValueError("bad version")
    names = set()
    for c in params["commits"]:
        if not SLUG.match(c["slug"]) or not SHA.match(c["sha"]) or not NAME.match(c["repoName"]):
            raise ValueError(f"bad commit {c!r}")
        if not SUBDIR.match(c.get("addonsSubdir", "")) or c.get("addonsSubdir", "").startswith("/"):
            raise ValueError(f"bad addons folder {c.get('addonsSubdir')!r}")
        if c["repoName"] in names:
            raise ValueError(f"repository {c['repoName']} twice")
        names.add(c["repoName"])
    if sum(1 for c in params["commits"] if c["isServer"]) != 1:
        raise ValueError("exactly one repository must provide odoo-bin")
    for s in params["steps"]:
        if s.get("type") != "install_test":
            raise ValueError(f"unknown step {s.get('type')}")
        for g in list(s.get("modules", [])) + list(s.get("excludeModules", [])):
            if not GLOB.match(g):
                raise ValueError(f"bad module pattern {g!r}")
        if not TAGS.match(s.get("testTags", "")):
            raise ValueError("bad test tags")
        if not isinstance(s.get("timeout"), int) or not 60 <= s["timeout"] <= 6 * 3600:
            raise ValueError("bad timeout")
    return assignment


# --------------------------------------------------------------------------- backend

class Backend:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, body=None, timeout=30):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.url}{path}",
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)


# --------------------------------------------------------------------------- builder

@dataclass
class Settings:
    host: str
    workers: int
    workdir: Path
    github_token: str
    memory: str
    cpus: str
    pg: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls):
        return cls(
            host=os.environ.get("RUNBOT_HOST") or socket.gethostname(),
            workers=int(os.environ.get("RUNBOT_WORKERS", "2")),
            workdir=Path(os.environ.get("RUNBOT_WORKDIR", "/srv/runbot")),
            github_token=os.environ.get("GITHUB_TOKEN", ""),
            memory=os.environ.get("RUNBOT_MEMORY", "3g"),
            cpus=os.environ.get("RUNBOT_CPUS", "1.5"),
            pg={k: os.environ.get(k, d) for k, d in
                (("PGHOST", "127.0.0.1"), ("PGPORT", "5432"), ("PGUSER", "runbot"), ("PGPASSWORD", ""))},
        )


def git_env(token: str) -> dict:
    """Credentials for github.com through the environment, never on a command line"""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env.update({
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}",
        })
    return env


DOCKERFILE = """\
FROM ubuntu:{ubuntu}
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \\
      python3 python3-venv python3-dev build-essential git curl ca-certificates \\
      libpq-dev libldap2-dev libsasl2-dev libxml2-dev libxslt1-dev libjpeg-dev zlib1g-dev \\
      libffi-dev libssl-dev fontconfig xfonts-75dpi xfonts-base postgresql-client \\
    && curl -fsSL -o /tmp/wk.deb https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.jammy_amd64.deb \\
    && apt-get install -y /tmp/wk.deb && rm -f /tmp/wk.deb \
    && curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*
COPY requirements/ /tmp/requirements/
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -U pip wheel setuptools \\
    && for f in /tmp/requirements/*.txt; do /opt/venv/bin/pip install --no-cache-dir -r "$f"; done
RUN useradd -u {uid} -m runbot
"""


class Builder:
    def __init__(self, backend: Backend, settings: Settings):
        self.backend = backend
        self.s = settings
        self.running: dict[int, threading.Event] = {}
        self.lock = threading.Lock()
        self.image_locks: dict[str, threading.Lock] = {}
        self.stop = threading.Event()
        for d in ("repos", "builds", "images"):
            (self.s.workdir / d).mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------- main loop
    def loop(self):
        while not self.stop.is_set():
            try:
                self.tick()
            except (urllib.error.URLError, OSError, ValueError) as e:
                _log.warning("backend unreachable: %s", e)
            self.stop.wait(10)

    def tick(self):
        with self.lock:
            running = list(self.running)
        _, reply = self.backend.call("POST", "/builder/heartbeat", {
            "host": self.s.host, "workers": self.s.workers, "running": running, "version": VERSION,
        })
        for build_id in (reply or {}).get("kill", []):
            with self.lock:
                if build_id in self.running:
                    _log.info("kill requested for build %s", build_id)
                    self.running[build_id].set()
        while len(self.running) < self.s.workers and not self.stop.is_set():
            status, assignment = self.backend.call("POST", "/builder/claim", {"host": self.s.host})
            if status == 204 or not assignment:
                break
            kill = threading.Event()
            with self.lock:
                self.running[assignment["buildId"]] = kill
            threading.Thread(target=self.run_safe, args=(assignment, kill), daemon=True).start()

    def run_safe(self, assignment: dict, kill: threading.Event):
        build_id = assignment.get("buildId")
        logs = LogSender(self.backend, build_id)
        try:
            validate(assignment)
            result, summary = self.run(assignment, kill, logs)
        except Exception as e:  # noqa: BLE001 -- any failure is the build's result
            _log.exception("build %s failed", build_id)
            logs.runbot(f"Builder error: {e}", level="ERROR")
            result, summary = "ko", f"Builder error: {e}"
        finally:
            logs.flush()
        try:
            self.backend.call("POST", f"/builder/builds/{build_id}/result",
                              {"result": result, "errorSummary": summary})
        except (urllib.error.URLError, OSError) as e:
            _log.error("could not report build %s: %s", build_id, e)
        with self.lock:
            self.running.pop(build_id, None)

    # ------------------------------------------------------------- one build
    def run(self, a: dict, kill: threading.Event, logs: "LogSender"):
        build_id, params, db = a["buildId"], a["params"], a["dbName"]
        root = self.s.workdir / "builds" / str(build_id)
        src, data = root / "src", root / "data"
        shutil.rmtree(root, ignore_errors=True)
        src.mkdir(parents=True)
        data.mkdir()
        try:
            for c in params["commits"]:
                logs.runbot(f"Checking out {c['slug']}@{c['sha'][:12]}")
                self.export(c, src / c["repoName"])
            server = next(c for c in params["commits"] if c["isServer"])
            addons_path, tested_modules = [], []
            for c in params["commits"]:
                base = src / c["repoName"]
                if c["isServer"]:
                    addons_path += [f"/data/src/{c['repoName']}/addons", f"/data/src/{c['repoName']}/odoo/addons"]
                    if c["tested"]:
                        tested_modules += find_modules(base / "addons")
                    continue
                folder = base / c["addonsSubdir"] if c["addonsSubdir"] else base
                addons_path.append("/data/src/" + str(folder.relative_to(src)))
                if c["tested"]:
                    tested_modules += find_modules(folder)
            image = self.ensure_image(params["version"], src, params["commits"], logs)
            result, summary = "ok", None
            for i, step in enumerate(params["steps"]):
                modules = select_modules(tested_modules, step["modules"], step["excludeModules"])
                if not modules:
                    logs.runbot("No module to install: check the trigger's module patterns", level="ERROR")
                    return "ko", "No module to install"
                step_db = db if len(params["steps"]) == 1 else f"{db}_{i + 1}"[:63]
                logs.runbot(f"Installing and testing {len(modules)} modules: {', '.join(modules)}")
                r, summary = self.run_step(build_id, step, step_db, modules, addons_path, server, image,
                                           data, src, kill, logs)
                result = worst(result, r)
                if r in ("ko", "killed"):
                    break
            return result, summary
        finally:
            self.cleanup(db, len(params["steps"]), root)

    def export(self, commit: dict, dest: Path):
        """git archive of one commit from a bare mirror (fetched by hash when missing)"""
        owner, name = commit["slug"].split("/")
        cache = self.s.workdir / "repos" / owner / f"{name}.git"
        env = git_env(self.s.github_token)
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            run(["git", "init", "--bare", "--quiet", str(cache)], env=env)
            run(["git", "-C", str(cache), "remote", "add", "origin", f"https://github.com/{commit['slug']}.git"], env=env)
        have = subprocess.run(["git", "-C", str(cache), "cat-file", "-e", f"{commit['sha']}^{{commit}}"],
                              env=env, capture_output=True).returncode == 0
        if not have:
            run(["git", "-C", str(cache), "fetch", "--quiet", "--depth=1", "origin", commit["sha"]], env=env, timeout=1800)
        dest.mkdir(parents=True)
        archive = subprocess.Popen(["git", "-C", str(cache), "archive", "--format=tar", commit["sha"]],
                                   stdout=subprocess.PIPE, env=env)
        run(["tar", "-x", "-C", str(dest)], stdin=archive.stdout)
        if archive.wait() != 0:
            raise RuntimeError(f"git archive failed for {commit['slug']}@{commit['sha']}")

    def ensure_image(self, version: str, src: Path, commits: list, logs: "LogSender") -> str:
        """One image per Odoo version and set of requirements files"""
        reqs = []
        for c in commits:
            f = src / c["repoName"] / "requirements.txt"
            if c["addonsSubdir"] and not f.exists():
                f = src / c["repoName"] / c["addonsSubdir"] / "requirements.txt"
            if f.exists():
                reqs.append((c["repoName"], f.read_bytes()))
        ubuntu = "22.04" if version.split(".")[0].isdigit() and int(version.split(".")[0]) <= 16 else "24.04"
        digest = hashlib.sha256(DOCKERFILE.encode() + ubuntu.encode()
                                + b"".join(n.encode() + b"\0" + r for n, r in reqs)).hexdigest()[:12]
        tag = f"runbot-odoo:{version}-{digest}"
        lock = self.image_locks.setdefault(tag, threading.Lock())
        with lock:
            if subprocess.run(["docker", "image", "inspect", tag], capture_output=True).returncode == 0:
                return tag
            logs.runbot(f"Building image {tag} (first build of this version and requirements)")
            ctx = self.s.workdir / "images" / digest
            shutil.rmtree(ctx, ignore_errors=True)
            (ctx / "requirements").mkdir(parents=True)
            for i, (name, content) in enumerate(reqs):
                (ctx / "requirements" / f"{i:02d}-{name}.txt").write_bytes(content)
            (ctx / "Dockerfile").write_text(DOCKERFILE.format(ubuntu=ubuntu, uid=os.getuid()))
            out = subprocess.run(["docker", "build", "-q", "-t", tag, str(ctx)], capture_output=True, text=True, timeout=3600)
            if out.returncode != 0:
                logs.runbot("Image build failed:\n" + out.stderr[-4000:], level="ERROR")
                raise RuntimeError("docker build failed")
            return tag

    def run_step(self, build_id, step, db, modules, addons_path, server, image, data: Path, src: Path,
                 kill: threading.Event, logs: "LogSender"):
        pg = self.s.pg
        conf = data / f"{db}.conf"
        conf.write_text(
            "[options]\n"
            f"addons_path = {','.join(addons_path)}\n"
            f"data_dir = /data/data/filestore\n"
            f"db_host = {pg['PGHOST']}\ndb_port = {pg['PGPORT']}\ndb_user = {pg['PGUSER']}\n"
            f"db_password = {pg['PGPASSWORD']}\nlist_db = False\nadmin_passwd = {os.urandom(12).hex()}\n"
        )
        conf.chmod(0o600)
        name = f"runbot-build-{build_id}"
        cmd = [
            "docker", "run", "--rm", "--name", name, "--network", "host",
            "--user", f"{os.getuid()}:{os.getgid()}", "--memory", self.s.memory, "--cpus", self.s.cpus,
            "--pids-limit", "1024", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "-v", f"{src}:/data/src:ro", "-v", f"{data}:/data/data:rw", image,
            "/opt/venv/bin/python", f"/data/src/{server['repoName']}/odoo-bin", "-c", f"/data/data/{db}.conf",
            "-d", db, "-i", ",".join(modules), "--test-enable", "--stop-after-init", "--max-cron-threads=0",
            "--log-level=info", f"--http-port={free_port()}", f"--gevent-port={free_port()}",
        ]
        if step.get("testTags"):
            cmd += ["--test-tags", step["testTags"]]
        if not step.get("demo", True):
            cmd += ["--without-demo=all"]
        started = time.monotonic()
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
        counts = {"error": 0, "warning": 0}
        timed_out = killed = False

        def watchdog():
            nonlocal timed_out, killed
            while proc.poll() is None:
                if kill.is_set():
                    killed = True
                elif time.monotonic() - started > step["timeout"]:
                    timed_out = True
                if killed or timed_out:
                    subprocess.run(["docker", "kill", name], capture_output=True)
                    return
                time.sleep(2)

        threading.Thread(target=watchdog, daemon=True).start()
        current = None
        for line in proc.stdout:
            line = line.rstrip("\n")
            rec = parse_line(line)
            if rec:
                if current:
                    logs.add(current)
                current = rec
                kind = classify(rec)
                if kind:
                    counts[kind] += 1
            elif current:
                current["message"] += "\n" + line
            elif line.strip():
                logs.add({"level": "INFO", "logger": "stdout", "message": line})
        if current:
            logs.add(current)
        code = proc.wait()
        if timed_out:
            logs.runbot(f"Killed after the step's timeout of {step['timeout']} s", level="ERROR")
        result = build_result(code, timed_out, killed, counts["error"], counts["warning"])
        logs.runbot(f"Step finished in {int(time.monotonic() - started)} s: {result} "
                    f"({counts['error']} errors, {counts['warning']} warnings, exit {code})")
        summary = "Timed out" if timed_out else None
        return result, summary

    def cleanup(self, db: str, steps: int, root: Path):
        names = [db] if steps == 1 else [f"{db}_{i + 1}"[:63] for i in range(steps)]
        env = {**os.environ, **self.s.pg}
        for n in names:
            subprocess.run(["dropdb", "--if-exists", "--force", n], env=env, capture_output=True)
        shutil.rmtree(root, ignore_errors=True)


def free_port() -> int:
    """A TCP port nothing listens on now (builds share the host network)"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def worst(a: str, b: str) -> str:
    order = ["ok", "warn", "ko", "killed"]
    return a if order.index(a) >= order.index(b) else b


def run(cmd, env=None, stdin=None, timeout=600):
    out = subprocess.run(cmd, env=env, stdin=stdin, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        # never echo the environment: it may hold the GitHub token
        raise RuntimeError(f"{' '.join(cmd[:4])}… failed: {out.stderr.strip()[-500:]}")
    return out


class LogSender:
    """Batches log records to the backend (every 200 records or 3 seconds)"""

    def __init__(self, backend: Backend, build_id):
        self.backend = backend
        self.build_id = build_id
        self.buf: list[dict] = []
        self.last = time.monotonic()

    def runbot(self, message: str, level="RUNBOT"):
        self.add({"level": level, "logger": "runbot", "message": message})

    def add(self, rec: dict):
        rec.setdefault("created", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        self.buf.append(rec)
        if len(self.buf) >= 200 or time.monotonic() - self.last > 3:
            self.flush()

    def flush(self):
        if not self.buf or self.build_id is None:
            return
        batch, self.buf = self.buf, []
        self.last = time.monotonic()
        try:
            self.backend.call("POST", f"/builder/builds/{self.build_id}/logs", {"lines": batch})
        except (urllib.error.URLError, OSError) as e:
            _log.warning("could not send logs of build %s: %s", self.build_id, e)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    url, token = os.environ.get("RUNBOT_URL"), os.environ.get("RUNBOT_TOKEN")
    if not url or not token:
        raise SystemExit("RUNBOT_URL and RUNBOT_TOKEN are required")
    builder = Builder(Backend(url, token), Settings.from_env())
    signal.signal(signal.SIGTERM, lambda *_: builder.stop.set())
    _log.info("builder %s %s: %s workers, workdir %s", builder.s.host, VERSION, builder.s.workers, builder.s.workdir)
    builder.loop()


if __name__ == "__main__":
    main()
