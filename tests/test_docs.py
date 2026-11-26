from pathlib import Path
import json


def test_privacy_md():
    privacy = Path(__file__).resolve().parents[1] / "PRIVACY.md"
    readme = Path(__file__).resolve().parents[1] / "README.md"
    assert privacy.is_file()
    content = privacy.read_text(encoding="utf-8").lower()
    assert "300" in content
    assert "telemetry" in content
    assert "[privacy.md](privacy.md)" in readme.read_text(encoding="utf-8").lower()


def test_security_md_chatgpt():
    security = Path(__file__).resolve().parents[1] / "SECURITY.md"
    content = security.read_text(encoding="utf-8")
    assert "temporary chat" in content.lower()
    assert "API backends** and **ChatGPT web" not in content


def test_changelog():
    root = Path(__file__).resolve().parents[1]
    changelog = root / "CHANGELOG.md"
    manifest = root / "extension" / "manifest.json"
    assert changelog.is_file()
    version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
    assert f"## [{version}]" in changelog.read_text(encoding="utf-8")
