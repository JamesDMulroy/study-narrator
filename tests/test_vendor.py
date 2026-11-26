import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_readability_vendor_notice_matches_file_hash():
    source = ROOT / "extension" / "lib" / "Readability.js"
    notices = (ROOT / "THIRD-PARTY-NOTICES.md").read_text(encoding="utf-8")
    match = re.search(r"^Version: [^\r\n]*, SHA-256: ([0-9a-f]{64})$", notices, re.MULTILINE)
    assert match is not None, "Readability version and SHA-256 notice line is missing"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == match.group(1)


def test_readability_vendor_module_and_license():
    source = (ROOT / "extension" / "lib" / "Readability.js").read_text(encoding="utf-8")
    assert re.search(r"Readability\.prototype|class\s+Readability\b", source)
    assert re.search(r"module\.exports\s*=", source)

    license_path = ROOT / "extension" / "lib" / "Readability-LICENSE.md"
    assert license_path.is_file()
    assert "apache" in license_path.read_text(encoding="utf-8").lower()
