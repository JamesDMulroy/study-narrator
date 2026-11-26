"""Exercise host/host.py exactly as the browser does (length-prefixed JSON over stdio).

Offline by default: ping, protocol and input-validation checks need no AI tool.
    python -m pytest tests/test_host.py
Live round trips (uses your own Claude Code / Codex login):
    python tests/test_host.py --claude [profile]
    python tests/test_host.py --codex [profile]
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import pytest

HOST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "host", "host.py")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def call_raw(payload: bytes, env=None, timeout=240):
    p = subprocess.run([sys.executable, "-I", HOST], input=payload, capture_output=True, timeout=timeout,
                       creationflags=NO_WINDOW, env=env)
    out = p.stdout
    (n,) = struct.unpack("=I", out[:4])
    return json.loads(out[4:4 + n])


def call(msg, env=None, timeout=240):
    data = json.dumps(msg).encode()
    return call_raw(struct.pack("=I", len(data)) + data, env=env, timeout=timeout)


@pytest.fixture
def env_factory(tmp_path):
    def make_env(config: dict | None = None):
        folder = str(tmp_path)
        path = os.path.join(folder, "config.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(config or {}, f)
        env = dict(os.environ)
        env["STUDY_NARRATOR_CONFIG"] = path
        env["STUDY_NARRATOR_DATA"] = folder
        return env
    return make_env


def test_ping_reports_version_and_profiles(env_factory):
    r = call({"action": "ping", "id": 7}, env=env_factory({"claude_profiles": {"work": {"CLAUDE_CONFIG_DIR": "x"}}}))
    assert r["ok"] and r["id"] == 7 and r["version"]
    assert r["claude_profiles"] == ["default", "work"]


def test_unknown_action_is_refused(env_factory):
    r = call({"action": "shell", "prompt": "x"}, env=env_factory())
    assert r["ok"] is False and "unknown action" in r["error"]


def test_model_names_are_validated(env_factory):
    r = call({"action": "claude", "model": "haiku & calc", "prompt": "x"}, env=env_factory())
    assert r["ok"] is False and "invalid model" in r["error"]


def test_profiles_must_be_configured(env_factory):
    r = call({"action": "claude", "account": "someone-else", "prompt": "x"}, env=env_factory())
    assert r["ok"] is False and "unknown claude profile" in r["error"]


def test_profiles_may_only_set_the_config_folder(env_factory):
    cfg = {"claude_profiles": {"evil": {"PATH": "x"}}}
    r = call({"action": "claude", "account": "evil", "prompt": "x"}, env=env_factory(cfg))
    assert r["ok"] is False and "only" in r["error"]


def test_oversized_messages_are_refused(env_factory):
    r = call_raw(struct.pack("=I", 64 * 1024 * 1024) + b"{}", env=env_factory())
    assert r["ok"] is False and "too large" in r["error"]


def test_missing_cli_is_reported(env_factory, tmp_path):
    cfg = {"claude_path": os.path.join(str(tmp_path), "no-such-claude.exe")}
    r = call({"action": "claude", "prompt": "x"}, env=env_factory(cfg))
    assert r["ok"] is False and "not found" in r["error"]


def test_claude_runs_without_tools_or_mcp_servers(env_factory, tmp_path):
    """The Claude Code call removes built-in tools and loads no MCP server from the user's configuration, so page
    text cannot reach the user's connectors. A stand-in CLI echoes the arguments it was given."""
    folder = str(tmp_path)
    script = os.path.join(folder, "fake_claude.py")
    with open(script, "w", encoding="utf-8") as f:
        f.write("import json, sys\nsys.stdin.read()\nprint(json.dumps({'result': json.dumps(sys.argv[1:])}))\n")
    if os.name == "nt":
        exe = os.path.join(folder, "claude.cmd")
        with open(exe, "w", encoding="utf-8") as f:
            f.write(f'@"{sys.executable}" -I "{script}" %*\n')
    else:
        exe = os.path.join(folder, "claude")
        with open(exe, "w", encoding="utf-8") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" -I "{script}" "$@"\n')
        os.chmod(exe, 0o755)
    r = call({"action": "claude", "prompt": "x", "system": "y"}, env=env_factory({"claude_path": exe}), timeout=60)
    assert r["ok"], r
    argv = json.loads(r["text"])
    assert "--strict-mcp-config" in argv and "--mcp-config" not in argv
    assert argv[argv.index("--tools") + 1] == ""


def test_truncated_message_is_refused(env_factory):
    r = call_raw(struct.pack("=I", 100) + b"{}", env=env_factory())
    assert r["ok"] is False and "incomplete" in r["error"]


if __name__ == "__main__":
    profile = sys.argv[-1] if len(sys.argv) > 2 else "default"
    t = time.time()
    print("ping", call({"action": "ping"}))
    for tool in ("claude", "codex"):
        if f"--{tool}" in sys.argv:
            r = call({"action": tool, "account": profile,
                      "system": "You are a friendly study tutor. Answer in one short spoken sentence, no markdown.",
                      "prompt": "What is a skill in the context of Claude Code, in one sentence?"})
            print(tool, round(time.time() - t, 1), "s", json.dumps(r)[:400])
