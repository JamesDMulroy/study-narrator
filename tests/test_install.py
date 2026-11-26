"""install.py builds a manifest that admits only the given extension IDs (no registry writes here)."""
import importlib.util
import os
import sys
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "sn_install", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "host", "install.py"))
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


def test_manifest_allows_only_the_given_ids():
    m = install.manifest(Path("launcher"), ["a" * 32])
    assert m["name"] == "study_narrator" and m["type"] == "stdio"
    assert m["allowed_origins"] == ["chrome-extension://" + "a" * 32 + "/"]


@pytest.mark.parametrize("bad", ["", "*", "chrome-extension://x/", "z" * 32, "a" * 31, "A" * 32])
def test_bad_extension_ids_are_refused(bad):
    with pytest.raises(SystemExit):
        install.main(["--extension-id", bad])


def test_launcher_runs_a_copied_host(tmp_path):
    launcher = install.write_launcher(tmp_path)
    copied_host = tmp_path / "host.py"
    assert copied_host.exists()
    assert copied_host.read_bytes() == install.HOST_PY.read_bytes()
    launcher_text = launcher.read_text(encoding="utf-8")
    assert str(copied_host) in launcher_text
    assert str(install.HOST_PY) not in launcher_text


def test_uninstall_removes_the_copy(tmp_path, monkeypatch):
    monkeypatch.setattr(install, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(install.os, "name", "posix")
    monkeypatch.setattr(install.Path, "home", lambda: tmp_path)
    install.write_launcher(tmp_path)
    install.uninstall()
    assert not (tmp_path / "host.py").exists()
