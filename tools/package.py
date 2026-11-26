#!/usr/bin/env python3
"""Create a reproducible release archive for the Study Narrator extension."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def excluded(path: Path) -> bool:
    return path.name == ".DS_Store" or path.suffix.lower() in {".pem", ".crx", ".zip"}


def package(out_dir: Path) -> Path:
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    archive = out_dir / f"study-narrator-{manifest['version']}.zip"
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(
        (path for path in EXTENSION.rglob("*") if path.is_file() and not excluded(path)),
        key=lambda path: path.relative_to(EXTENSION).as_posix(),
    )
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as bundle:
        for path in files:
            relative = path.relative_to(EXTENSION).as_posix()
            info = ZipInfo(relative, date_time=FIXED_TIME)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, path.read_bytes())
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist", help="output directory")
    args = parser.parse_args()
    print(package(args.out.resolve()))


if __name__ == "__main__":
    main()
