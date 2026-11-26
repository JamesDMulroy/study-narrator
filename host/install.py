"""Register (or remove) the Study Narrator native-messaging host for your user.

    python host/install.py --extension-id <32-letter id from edge://extensions or chrome://extensions>
    python host/install.py --uninstall

It writes a small launcher and the host manifest into your per-user data folder, then registers the
manifest for Microsoft Edge, Google Chrome and Chromium (Windows: HKCU registry keys; macOS and Linux:
the browsers' per-user NativeMessagingHosts folders). Only the extension ID you pass is allowed to start
the host. Nothing needs administrator rights, and nothing outside your user profile is changed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

HOST_NAME = "study_narrator"
HOST_PY = Path(__file__).resolve().with_name("host.py")
ID_RE = re.compile(r"^[a-p]{32}$")

WIN_KEYS = [r"Software\Microsoft\Edge\NativeMessagingHosts",
            r"Software\Google\Chrome\NativeMessagingHosts",
            r"Software\Chromium\NativeMessagingHosts"]
MAC_DIRS = ["Library/Application Support/Microsoft Edge/NativeMessagingHosts",
            "Library/Application Support/Google/Chrome/NativeMessagingHosts",
            "Library/Application Support/Chromium/NativeMessagingHosts"]
LINUX_DIRS = [".config/microsoft-edge/NativeMessagingHosts",
              ".config/google-chrome/NativeMessagingHosts",
              ".config/chromium/NativeMessagingHosts"]


def data_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    elif sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "StudyNarrator" / "native-host"


def write_launcher(folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    host_copy = folder / "host.py"
    shutil.copy2(HOST_PY, host_copy)
    if os.name == "nt":
        launcher = folder / "host.cmd"
        launcher.write_text(f'@echo off\r\n"{sys.executable}" -I "{host_copy}"\r\n', encoding="utf-8")
    else:
        launcher = folder / "host.sh"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" -I "{host_copy}"\n', encoding="utf-8")
        launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR)
    return launcher


def manifest(launcher: Path, extension_ids: list[str]) -> dict:
    return {"name": HOST_NAME,
            "description": "Study Narrator: runs a local AI command-line tool for the Study Narrator extension",
            "path": str(launcher), "type": "stdio",
            "allowed_origins": [f"chrome-extension://{i}/" for i in extension_ids]}


def install(extension_ids: list[str]) -> list[str]:
    folder = data_dir()
    launcher = write_launcher(folder)
    body = json.dumps(manifest(launcher, extension_ids), indent=2)
    done = []
    if os.name == "nt":
        import winreg
        path = folder / f"{HOST_NAME}.json"
        path.write_text(body, encoding="utf-8")
        for key in WIN_KEYS:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key + "\\" + HOST_NAME) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, str(path))
            done.append("HKCU\\" + key + "\\" + HOST_NAME)
    else:
        for rel in (MAC_DIRS if sys.platform == "darwin" else LINUX_DIRS):
            target = Path.home() / rel
            target.mkdir(parents=True, exist_ok=True)
            (target / f"{HOST_NAME}.json").write_text(body, encoding="utf-8")
            done.append(str(target / f"{HOST_NAME}.json"))
    return done


def uninstall() -> list[str]:
    removed = []
    if os.name == "nt":
        import winreg
        for key in WIN_KEYS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key + "\\" + HOST_NAME)
                removed.append("HKCU\\" + key + "\\" + HOST_NAME)
            except FileNotFoundError:
                pass
    else:
        for rel in (MAC_DIRS if sys.platform == "darwin" else LINUX_DIRS):
            path = Path.home() / rel / f"{HOST_NAME}.json"
            if path.exists():
                path.unlink()
                removed.append(str(path))
    folder = data_dir()
    for name in ("host.cmd", "host.sh", "host.py", f"{HOST_NAME}.json"):
        if (folder / name).exists():
            (folder / name).unlink()
            removed.append(str(folder / name))
    return removed


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--extension-id", action="append", default=[],
                    help="the extension's ID (repeat for several browsers or profiles)")
    ap.add_argument("--uninstall", action="store_true")
    a = ap.parse_args(argv)
    if a.uninstall:
        print(json.dumps({"removed": uninstall()}, indent=2))
        return 0
    bad = [i for i in a.extension_id if not ID_RE.match(i)]
    if not a.extension_id or bad:
        ap.error("pass --extension-id with the 32-letter ID shown on the browser's extensions page")
    print(json.dumps({"host": HOST_NAME, "registered": install(a.extension_id),
                      "allowed_origins": [f"chrome-extension://{i}/" for i in a.extension_id]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
