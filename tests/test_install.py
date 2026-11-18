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
