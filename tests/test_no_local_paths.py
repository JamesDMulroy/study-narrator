from pathlib import Path
import re
import subprocess


def test_tracked_text_files_have_no_personal_absolute_paths():
    root = Path(__file__).resolve().parents[1]
    tracked = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True
    ).stdout.split(b"\0")
    patterns = [re.compile(r"[A-Za-z]:\\Users\\"), re.compile(r"/home/[a-z]"), re.compile(r"AppData")]
    binary_extensions = {".png", ".jpg", ".jpeg", ".ico", ".zip"}
    hits = []

    for item in tracked:
        if not item:
            continue
        relative = Path(item.decode("utf-8"))
        if any(part in {".git", "node_modules", "dist"} for part in relative.parts):
            continue
        if relative.suffix.lower() in binary_extensions or relative.name == Path(__file__).name:
            continue  # binaries, and this file (it holds the patterns)
        path = root / relative
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(content.splitlines(), 1):
            if any(pattern.search(line) for pattern in patterns):
                hits.append(f"{relative}:{number}")

    assert not hits, "Personal absolute paths found:\n" + "\n".join(hits)
