r"""Study Narrator native-messaging host.

The browser launches this once per request (chrome.runtime.sendNativeMessage). It reads one JSON message
from stdin (4-byte length prefix, native byte order), runs a local AI command-line tool with your own
login, and writes one JSON reply. Only the extension IDs listed in the host manifest's
``allowed_origins`` can start it (see install.py).

Request:  {"action": "ping"}
          {"action": "claude", "prompt": str, "system": str, "model": "haiku"|"sonnet"|...,
           "account": <profile name>, "timeout": seconds}
          {"action": "codex", ... same fields ...}
Reply:    {"ok": true, "text": str, "model": str, "ms": int}  |  {"ok": false, "error": str}

Configuration (all optional): a JSON file at $STUDY_NARRATOR_CONFIG, else
<user config dir>/StudyNarrator/config.json:

    {
      "claude_path": "/full/path/to/claude",        # default: "claude" on PATH
      "codex_path": "/full/path/to/codex",          # default: "codex" on PATH
      "claude_profiles": {"work": {"CLAUDE_CONFIG_DIR": "/path/to/another/claude/config"}},
      "codex_profiles": {"work": {"CODEX_HOME": "/path/to/another/codex/home"}},
      "fallback_profile": "work"                    # retried once when a profile hits a usage limit
    }

A profile only sets the listed environment variables for the CLI; "default" is the CLI's own login. Only
CLAUDE_CONFIG_DIR and CODEX_HOME may be set. The host never reads tokens or credentials itself.

The prompt (which carries page text) is passed on stdin, never on the command line. No window is
created: browsers start hosts hidden and child processes use CREATE_NO_WINDOW on Windows.
Log (request metadata only, never prompt text): <user data dir>/StudyNarrator/host.log
($STUDY_NARRATOR_DATA overrides the data folder.)
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time

VERSION = "1.3.0"
MAX_MESSAGE = 8 * 1024 * 1024          # bytes; the browser never needs more for one request
MAX_TIMEOUT = 600.0                    # seconds
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$")
PROFILE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
PROFILE_VARS = {"claude": {"CLAUDE_CONFIG_DIR"}, "codex": {"CODEX_HOME"}}
LIMIT_WORDS = ("limit", "quota", "rate_limit", "usage", "insufficient")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _user_dir(kind: str) -> str:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA" if kind == "data" else "APPDATA") or os.path.expanduser("~")
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME" if kind == "data" else "XDG_CONFIG_HOME") or \
            os.path.join(os.path.expanduser("~"), ".local/share" if kind == "data" else ".config")
    return os.path.join(base, "StudyNarrator")


DATA = os.environ.get("STUDY_NARRATOR_DATA") or _user_dir("data")
LOG = os.path.join(DATA, "host.log")
CWD = os.path.join(DATA, "cwd")  # an empty working folder, so no project instructions are picked up


def config() -> dict:
    path = os.environ.get("STUDY_NARRATOR_CONFIG") or os.path.join(_user_dir("config"), "config.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise RuntimeError(f"cannot read config {path}: {e}")


def log(msg: str) -> None:
    try:
        os.makedirs(DATA, exist_ok=True)
        if os.path.exists(LOG) and os.path.getsize(LOG) > 1_000_000:
            os.replace(LOG, LOG + ".1")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("=I", raw)
    if n > MAX_MESSAGE:
        raise ValueError(f"message too large ({n} bytes)")
    body = sys.stdin.buffer.read(n)
    if len(body) != n:
        raise ValueError("incomplete message")
    msg = json.loads(body.decode("utf-8"))
    if not isinstance(msg, dict):
        raise ValueError("message must be a JSON object")
    return msg


def send_message(obj) -> None:
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def find_cli(tool: str, cfg: dict) -> str | None:
    explicit = cfg.get(f"{tool}_path")
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    return shutil.which(tool)


def _is_batch(exe: str) -> bool:
    # cmd.exe re-parses the arguments of a .cmd/.bat file, so nothing caller-influenced may go on its
    # command line (the "BatBadBut" class of injection).
    return os.name == "nt" and exe.lower().endswith((".cmd", ".bat"))


def _text(req: dict, name: str) -> str:
    value = req.get(name) or ""
    if not isinstance(value, str):
        raise RuntimeError(f"{name} must be a string")
    return value


def _model(req: dict, default: str) -> str:
    model = req.get("model") or default
    if model and (not isinstance(model, str) or not MODEL_RE.match(model)):
        raise RuntimeError("invalid model name")
    return model


def _timeout(req: dict, default: float) -> float:
    try:
        value = float(req.get("timeout") or default)
    except (TypeError, ValueError):
        raise RuntimeError("invalid timeout")
    return max(5.0, min(value, MAX_TIMEOUT))


def profile_env(tool: str, name, cfg: dict) -> dict:
    env = dict(os.environ)
    name = name or "default"
    if not isinstance(name, str) or not PROFILE_RE.match(name):
        raise RuntimeError("invalid profile name")
    if name != "default":
        profile = (cfg.get(f"{tool}_profiles") or {}).get(name)
        if not isinstance(profile, dict):
            raise RuntimeError(f"unknown {tool} profile '{name}' (configure it in the host's config.json)")
        for var, value in profile.items():
            if var not in PROFILE_VARS[tool] or not isinstance(value, str):
                raise RuntimeError(f"{tool} profile '{name}': only {sorted(PROFILE_VARS[tool])} may be set")
            env[var] = value
    env.pop("CLAUDECODE", None)  # allow running from inside another Claude Code session
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)
    return env


def run_claude(req: dict, cfg: dict) -> dict:
    prompt, system = _text(req, "prompt"), _text(req, "system")
    model = _model(req, "haiku")
    timeout = _timeout(req, 180)
    exe = find_cli("claude", cfg)
    if not exe:
        raise RuntimeError("claude CLI not found (install Claude Code, or set claude_path in config.json)")
    os.makedirs(CWD, exist_ok=True)
    cmd = [exe, "-p", "--output-format", "json", "--model", model,
           "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "user"]
    if system and _is_batch(exe):
        prompt = f"<instructions>\n{system}\n</instructions>\n\n{prompt}"
    elif system:
        cmd += ["--system-prompt", system]
    env = profile_env("claude", req.get("account"), cfg)
    t0 = time.time()
    proc = subprocess.run(cmd, input=prompt.encode("utf-8"), capture_output=True, cwd=CWD, env=env,
                          timeout=timeout, creationflags=NO_WINDOW)
    ms = int((time.time() - t0) * 1000)
    out = proc.stdout.decode("utf-8", errors="replace").strip()
    err = proc.stderr.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0 and not out:
        raise RuntimeError(f"claude exited {proc.returncode}: {err[-800:] or 'no output'}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return {"ok": True, "text": out, "model": model, "ms": ms}  # plain-text output (older CLI)
    if isinstance(data, list):
        data = next((d for d in data if isinstance(d, dict) and d.get("type") == "result"),
                    data[-1] if data else {})
    if not isinstance(data, dict):
        raise RuntimeError("unexpected claude output")
    if data.get("is_error"):
        raise RuntimeError(str(data.get("result") or data.get("error") or "claude error")[:800])
    text = data.get("result")
    if text is None:
        raise RuntimeError("no result field in claude output")
    return {"ok": True, "text": text, "model": data.get("model") or model, "ms": ms,
            "cost_usd": data.get("total_cost_usd")}


def run_codex(req: dict, cfg: dict) -> dict:
    """Run the Codex CLI non-interactively (codex exec) with your own ChatGPT/Codex login."""
    prompt, system = _text(req, "prompt"), _text(req, "system")
    model = _model(req, "")
    timeout = _timeout(req, 240)
    exe = find_cli("codex", cfg)
    if not exe:
        raise RuntimeError("codex CLI not found (install Codex, or set codex_path in config.json)")
    os.makedirs(CWD, exist_ok=True)
    env = profile_env("codex", req.get("account"), cfg)
    out_file = os.path.join(CWD, f"codex-{os.getpid()}.txt")
    full = (f"<instructions>\n{system}\n</instructions>\n\n" if system else "") + prompt + \
        "\n\nReply with the final answer only. Do not run commands, read files or explore the workspace."
    cmd = [exe, "exec"] + (["-m", model] if model else []) + \
          ["-s", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-C", CWD, "-o", out_file, "-"]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, input=full.encode("utf-8"), capture_output=True, cwd=CWD, env=env,
                              timeout=timeout, creationflags=NO_WINDOW)
        ms = int((time.time() - t0) * 1000)
        text = ""
        if os.path.exists(out_file):
            with open(out_file, encoding="utf-8", errors="replace") as f:
                text = f.read().strip()
    finally:
        try:
            os.remove(out_file)
        except OSError:
            pass
    if not text:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        out = proc.stdout.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"codex exited {proc.returncode}: {(err or out)[-800:] or 'no output'}")
    return {"ok": True, "text": text, "model": model or "(codex default)", "ms": ms}


def with_fallback(req: dict, cfg: dict, runner):
    try:
        return runner(req, cfg)
    except RuntimeError as e:
        msg = str(e).lower()
        other = cfg.get("fallback_profile")
        current = req.get("account") or "default"
        if other and other != current and req.get("fallback", True) and any(w in msg for w in LIMIT_WORDS):
            log(f"profile {current} limited; retrying on {other}")
            reply = runner({**req, "account": other}, cfg)
            reply["account"] = other
            return reply
        raise


def handle(req: dict) -> dict:
    action = req.get("action")
    cfg = config()
    if action == "ping":
        return {"ok": True, "version": VERSION, "claude_found": bool(find_cli("claude", cfg)),
                "codex_found": bool(find_cli("codex", cfg)), "python": sys.version.split()[0],
                "claude_profiles": ["default", *sorted(cfg.get("claude_profiles") or {})],
                "codex_profiles": ["default", *sorted(cfg.get("codex_profiles") or {})]}
    if action == "claude":
        return with_fallback(req, cfg, run_claude)
    if action == "codex":
        return with_fallback(req, cfg, run_codex)
    return {"ok": False, "error": "unknown action"}


def main() -> None:
    rid = None
    try:
        req = read_message()
        if req is None:
            return
        rid = req.get("id")
        prompt = req.get("prompt")
        log(f"request {str(req.get('action'))[:20]} model={str(req.get('model'))[:40]} "
            f"prompt_chars={len(prompt) if isinstance(prompt, str) else 0}")
        reply = handle(req)
    except subprocess.TimeoutExpired:
        reply = {"ok": False, "error": "the AI command timed out"}
    except Exception as e:  # noqa: BLE001 - report everything to the extension
        reply = {"ok": False, "error": str(e)}
    reply["id"] = rid
    log(f"reply ok={reply.get('ok')} ms={reply.get('ms')} err={str(reply.get('error'))[:200]}")
    send_message(reply)


if __name__ == "__main__":
    main()
