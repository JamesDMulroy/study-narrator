import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "package.py"
EXTENSION = ROOT / "extension"


def test_package_is_complete_and_reproducible(tmp_path):
    command = [sys.executable, "-I", str(SCRIPT), "--out", str(tmp_path)]
    options = {}
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NO_WINDOW

    first = subprocess.run(command, check=True, capture_output=True, text=True, **options)
    archive = Path(first.stdout.strip())
    assert archive.is_file()

    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    assert archive.name == f"study-narrator-{manifest['version']}.zip"
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        assert "manifest.json" in names
        expected = {
            path.relative_to(EXTENSION).as_posix()
            for path in EXTENSION.rglob("*")
            if path.is_file()
            and path.name != ".DS_Store"
            and path.suffix.lower() not in {".pem", ".crx", ".zip"}
        }
        assert set(names) == expected
        assert names == sorted(names)
        assert all(item.date_time == (1980, 1, 1, 0, 0, 0) for item in bundle.infolist())
        assert all(name.startswith("manifest.json") or not name.startswith("../") for name in names)

    first_bytes = archive.read_bytes()
    subprocess.run(command, check=True, capture_output=True, text=True, **options)
    assert archive.read_bytes() == first_bytes
